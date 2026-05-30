import { mkdir } from 'node:fs/promises';
import { readAuthAccountInfo } from './auth-jwt.ts';
import { copyFileAtomic, pathExists, readJsonIfExists, removePath, writeJsonAtomic } from './fs.ts';
import { isAccountMeta, isAccountQuota, isAccountsState } from './guards.ts';
import {
  accountAuthPath,
  accountHome,
  accountMetaPath,
  accountQuotaPath,
  accountsRoot,
  accountsStatePath,
  runsRoot
} from './paths.ts';
import type { AccountMeta, AccountQuota, AccountSummary, AccountsState } from './types.ts';

type CreateAccountMeta = Omit<
  AccountMeta,
  'alias' | 'createdAt' | 'updatedAt' | 'tokenStatus' | 'tokenInvalidatedAt' | 'tokenInvalidReason'
>;

export function assertAlias(alias: string): void {
  const trimmed = alias.trim();
  if (trimmed.length === 0) {
    throw new Error('请输入账号别名。');
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error('账号别名不能是点或双点。');
  }
  if (!/^[A-Za-z0-9._@+-]+$/.test(trimmed)) {
    throw new Error('账号别名只能包含字母、数字、@、点、下划线和短横线。');
  }
}

export function emptyState(): AccountsState {
  return {
    version: 1,
    accounts: [],
    activeAccount: null,
    updatedAt: new Date().toISOString()
  };
}

export class AccountStore {
  constructor(private readonly appHome: string) {}

  async ensureLayout(): Promise<void> {
    await mkdir(this.appHome, { recursive: true });
    await mkdir(accountsRoot(this.appHome), { recursive: true });
    await mkdir(runsRoot(this.appHome), { recursive: true });
  }

  async loadState(): Promise<AccountsState> {
    await this.ensureLayout();
    const parsed = await readJsonIfExists(accountsStatePath(this.appHome));
    if (parsed === null) {
      return emptyState();
    }
    if (!isAccountsState(parsed)) {
      throw new Error('accounts.json 格式不正确。');
    }
    return parsed;
  }

  async saveState(state: AccountsState): Promise<void> {
    await this.ensureLayout();
    await writeJsonAtomic(accountsStatePath(this.appHome), {
      ...state,
      updatedAt: new Date().toISOString()
    });
  }

  async hasAccount(alias: string): Promise<boolean> {
    const state = await this.loadState();
    return state.accounts.some((account) => account.alias === alias);
  }

  async requireAccount(alias: string): Promise<void> {
    if (!(await this.hasAccount(alias))) {
      throw new Error(`账号 ${alias} 不存在。`);
    }
  }

  async createAccount(alias: string, authSourcePath: string, meta: CreateAccountMeta): Promise<void> {
    assertAlias(alias);
    const state = await this.loadState();
    if (state.accounts.some((account) => account.alias === alias)) {
      throw new Error(`账号 ${alias} 已存在。`);
    }

    const now = new Date().toISOString();
    await mkdir(accountHome(this.appHome, alias), { recursive: true });
    await copyFileAtomic(authSourcePath, accountAuthPath(this.appHome, alias));
    await this.writeMeta({
      alias,
      email: meta.email,
      planType: meta.planType,
      subscriptionExpiresAt: meta.subscriptionExpiresAt,
      tokenStatus: "valid",
      tokenInvalidatedAt: null,
      tokenInvalidReason: null,
      createdAt: now,
      updatedAt: now
    });
    state.accounts.push({ alias, createdAt: now });
    await this.saveState(state);
  }

  async deleteAccount(alias: string): Promise<void> {
    assertAlias(alias);
    const state = await this.loadState();
    if (!state.accounts.some((account) => account.alias === alias)) {
      throw new Error(`账号 ${alias} 不存在。`);
    }
    if (state.activeAccount === alias) {
      throw new Error(`账号 ${alias} 正在使用。请先运行 bun cli deactive。`);
    }
    await removePath(accountHome(this.appHome, alias));
    state.accounts = state.accounts.filter((account) => account.alias !== alias);
    await this.saveState(state);
  }

  async setActive(alias: string | null): Promise<void> {
    const state = await this.loadState();
    if (alias !== null && !state.accounts.some((account) => account.alias === alias)) {
      throw new Error(`账号 ${alias} 不存在。`);
    }
    state.activeAccount = alias;
    await this.saveState(state);
  }

  async listSummaries(): Promise<AccountSummary[]> {
    const state = await this.loadState();
    const summaries: AccountSummary[] = [];
    for (const account of state.accounts) {
      const alias = account.alias;
      const hasAuth = await pathExists(accountAuthPath(this.appHome, alias));
      const meta = await this.syncMetaFromAuthJwt(alias, account.createdAt, hasAuth);
      summaries.push({
        alias,
        isActive: state.activeAccount === alias,
        hasAuth,
        tokenStatus: hasAuth ? (meta?.tokenStatus ?? "valid") : "missing",
        tokenInvalidatedAt: meta?.tokenInvalidatedAt ?? null,
        tokenInvalidReason: meta?.tokenInvalidReason ?? null,
        meta,
        quota: await this.readQuota(alias)
      });
    }
    return summaries;
  }

  async authPath(alias: string): Promise<string> {
    await this.requireAccount(alias);
    return accountAuthPath(this.appHome, alias);
  }

  async replaceAuth(alias: string, authSourcePath: string): Promise<void> {
    await this.requireAccount(alias);
    await copyFileAtomic(authSourcePath, accountAuthPath(this.appHome, alias));
  }

  async readMeta(alias: string): Promise<AccountMeta | null> {
    const parsed = await readJsonIfExists(accountMetaPath(this.appHome, alias));
    if (parsed === null) return null;
    if (!isAccountMeta(parsed)) {
      throw new Error(`账号 ${alias} 的 meta.json 格式不正确。`);
    }
    return normalizeAccountMeta(parsed);
  }

  async writeMeta(meta: AccountMeta): Promise<void> {
    await writeJsonAtomic(accountMetaPath(this.appHome, meta.alias), {
      ...meta,
      tokenStatus: meta.tokenStatus ?? "valid",
      tokenInvalidatedAt: meta.tokenInvalidatedAt ?? null,
      tokenInvalidReason: meta.tokenInvalidReason ?? null,
      updatedAt: new Date().toISOString()
    });
  }

  async markTokenInvalid(alias: string, reason: string | null = null): Promise<void> {
    const state = await this.loadState();
    const meta = await this.readMeta(alias);
    const now = new Date().toISOString();
    await this.writeMeta({
      alias,
      email: meta?.email ?? null,
      planType: meta?.planType ?? null,
      subscriptionExpiresAt: meta?.subscriptionExpiresAt ?? null,
      tokenStatus: "invalid",
      tokenInvalidatedAt: now,
      tokenInvalidReason: reason,
      createdAt: meta?.createdAt ?? state.accounts.find((account) => account.alias === alias)?.createdAt ?? now,
      updatedAt: now
    });
    if (state.activeAccount === alias) {
      state.activeAccount = null;
      await this.saveState(state);
    }
  }

  async markTokenValid(alias: string): Promise<void> {
    const meta = await this.readMeta(alias);
    if (meta === null) return;
    await this.writeMeta({
      ...meta,
      tokenStatus: "valid",
      tokenInvalidatedAt: null,
      tokenInvalidReason: null
    });
  }

  private async syncMetaFromAuthJwt(
    alias: string,
    createdAt: string,
    hasAuth: boolean
  ): Promise<AccountMeta | null> {
    const existing = await this.readMeta(alias);
    if (!hasAuth) return existing;
    const authAccount = await readAuthAccountInfo(accountAuthPath(this.appHome, alias));
    if (authAccount === null) return existing;
    if (
      authAccount.email === null &&
      authAccount.planType === null &&
      authAccount.subscriptionExpiresAt === null
    ) {
      return existing;
    }

    const now = new Date().toISOString();
    const next: AccountMeta = {
      alias,
      email: existing?.email ?? authAccount.email,
      planType: authAccount.planType ?? existing?.planType ?? null,
      subscriptionExpiresAt:
        authAccount.planType === "free"
          ? null
          : (authAccount.subscriptionExpiresAt ??
            existing?.subscriptionExpiresAt ??
            null),
      createdAt: existing?.createdAt ?? createdAt,
      tokenStatus: existing?.tokenStatus ?? "valid",
      tokenInvalidatedAt: existing?.tokenInvalidatedAt ?? null,
      tokenInvalidReason: existing?.tokenInvalidReason ?? null,
      updatedAt: now
    };
    if (
      existing !== null &&
      existing.email === next.email &&
      existing.planType === next.planType &&
      existing.subscriptionExpiresAt === next.subscriptionExpiresAt &&
      existing.tokenStatus === next.tokenStatus &&
      existing.tokenInvalidatedAt === next.tokenInvalidatedAt &&
      existing.tokenInvalidReason === next.tokenInvalidReason
    ) {
      return existing;
    }
    await this.writeMeta(next);
    return next;
  }

  async readQuota(alias: string): Promise<AccountQuota | null> {
    const parsed = await readJsonIfExists(accountQuotaPath(this.appHome, alias));
    if (parsed === null) return null;
    if (!isAccountQuota(parsed)) {
      throw new Error(`账号 ${alias} 的 quota.json 格式不正确。`);
    }
    return parsed;
  }

  async writeQuota(alias: string, quota: AccountQuota): Promise<void> {
    await writeJsonAtomic(accountQuotaPath(this.appHome, alias), {
      ...quota,
      updatedAt: new Date().toISOString()
    });
  }
}

function normalizeAccountMeta(meta: AccountMeta): AccountMeta {
  return {
    ...meta,
    tokenStatus: meta.tokenStatus ?? "valid",
    tokenInvalidatedAt: meta.tokenInvalidatedAt ?? null,
    tokenInvalidReason: meta.tokenInvalidReason ?? null
  };
}
