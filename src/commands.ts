import path from 'node:path';
import { readAcpAccount, readAcpSnapshot } from './acp.ts';
import { activateAuth, cleanupRunHome, hasCodexAuth, prepareAcpHome, runCodexLogin, runCodexLogout } from './codex.ts';
import { launchCodexDesktop, quitCodexDesktop } from './desktop.ts';
import { pathExists } from './fs.ts';
import { renderList } from './format.ts';
import { withLock } from './lock.ts';
import { confirm, selectAlias } from './prompt.ts';
import { AccountStore, assertAlias } from './store.ts';
import type { AccountMeta, AccountSummary, AcpAccountInfo, CommandContext } from './types.ts';

export async function addCommand(context: CommandContext, alias: string): Promise<void> {
  assertAlias(alias);
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    if (await store.hasAccount(alias)) {
      context.stdout.write(`账号 ${alias} 已保存，没有添加新账号。\n`);
      return;
    }

    const liveAuth = path.join(context.codexHome, 'auth.json');
    if (await hasCodexAuth(context.codexHome)) {
      const account = await readAcpAccount(context.codexBin, context.codexHome, context.cwd);
      const savedAccount = findSavedAccount(await store.listSummaries(), account);
      if (savedAccount === null) {
        await confirmAccountAlias(account, alias);
        await store.createAccount(alias, liveAuth, account);
        await store.setActive(alias);
        context.stdout.write(`已添加并激活账号 ${alias}。\n`);
        return;
      }

      context.stdout.write(`当前登录账号已保存为 ${savedAccount.alias}，没有添加新账号。\n`);
      return;
    }

    await runCodexLogin(context.codexBin, context.codexHome, context.cwd);
    if (!(await pathExists(liveAuth))) {
      throw new Error('登录完成后没有生成 auth.json。');
    }
    const account = await readAcpAccount(context.codexBin, context.codexHome, context.cwd).catch(() => ({
      email: null,
      planType: null,
      subscriptionExpiresAt: null
    }));
    const savedAccount = findSavedAccount(await store.listSummaries(), account);
    if (savedAccount !== null) {
      context.stdout.write(`该账号已保存为 ${savedAccount.alias}，没有添加新账号。\n`);
      return;
    }
    await confirmAccountAlias(account, alias);
    await store.createAccount(alias, liveAuth, account);
    await store.setActive(alias);
    await launchCodexDesktop();
    context.stdout.write(`已添加并激活账号 ${alias}。\n`);
  });
}

export async function listCommand(context: CommandContext): Promise<void> {
  const store = new AccountStore(context.appHome);
  context.stdout.write(`${renderList(await store.listSummaries())}\n`);
}

export async function deleteCommand(context: CommandContext, alias?: string): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await store.loadState();
    const target = alias ?? (await selectAlias(state.accounts.map((account) => account.alias), '删除'));
    await store.deleteAccount(target);
    context.stdout.write(`已删除账号 ${target}。\n`);
  });
}

export async function deactiveCommand(context: CommandContext): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    await quitCodexDesktop();
    await runCodexLogout(context.codexBin, context.codexHome, context.cwd).catch(() => undefined);
    await store.setActive(null);
    context.stdout.write('已退出当前 Codex 账号。\n');
  });
}

export async function activeCommand(context: CommandContext, alias?: string): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await store.loadState();
    const target = alias ?? (await selectAlias(state.accounts.map((account) => account.alias), '激活'));
    const authPath = await store.authPath(target);
    await quitCodexDesktop();
    await runCodexLogout(context.codexBin, context.codexHome, context.cwd).catch(() => undefined);
    await activateAuth(authPath, context.codexHome);

    const account = await readAcpAccount(context.codexBin, context.codexHome, context.cwd);
    const meta = await store.readMeta(target);
    await store.writeMeta(mergeMeta(target, meta, account));
    await store.setActive(target);
    await launchCodexDesktop();
    context.stdout.write(`已激活账号 ${target}。\n`);
  });
}

export async function updateCommand(context: CommandContext): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await store.loadState();
    if (state.accounts.length === 0) {
      throw new Error('没有账号可刷新。');
    }

    const failures: string[] = [];
    for (const account of state.accounts) {
      const alias = account.alias;
      let runHome: string | null = null;
      try {
        runHome = await prepareAcpHome({
          appHome: context.appHome,
          codexHome: context.codexHome,
          authPath: await store.authPath(alias)
        });
        const snapshot = await readAcpSnapshot(context.codexBin, runHome, context.cwd);
        await store.writeMeta(mergeMeta(alias, await store.readMeta(alias), snapshot.account, { clearSubscriptionIfNotSubscribed: true }));
        await store.writeQuota(alias, snapshot.quota);
        context.stdout.write(`已刷新 ${alias}。\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${alias}: ${message}`);
      } finally {
        if (runHome !== null) {
          await cleanupRunHome(runHome);
        }
      }
    }

    if (failures.length > 0) {
      throw new Error(`部分账号刷新失败：\n${failures.join('\n')}`);
    }

    context.stdout.write(`\n${renderList(await store.listSummaries())}\n`);
  });
}

export async function subCommand(context: CommandContext, dateText: string, alias?: string): Promise<void> {
  const subscriptionExpiresAt = parseSubscriptionDate(dateText);
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await store.loadState();
    if (state.accounts.length === 0) {
      throw new Error('没有账号可更新订阅日期。');
    }
    const target = alias ?? state.activeAccount ?? (await selectAlias(state.accounts.map((account) => account.alias), '更新订阅日期'));
    await store.requireAccount(target);
    const meta = await store.readMeta(target);
    const now = new Date().toISOString();
    await store.writeMeta({
      alias: target,
      email: meta?.email ?? null,
      planType: meta?.planType ?? null,
      subscriptionExpiresAt,
      createdAt: meta?.createdAt ?? now,
      updatedAt: now
    });
    context.stdout.write(`已更新 ${target} 的订阅到期日期为 ${dateText}。\n`);
  });
}

function mergeMeta(alias: string, existing: AccountMeta | null, next: {
  email: string | null;
  planType: string | null;
  subscriptionExpiresAt: string | null;
}, options: { clearSubscriptionIfNotSubscribed?: boolean } = {}): AccountMeta {
  const now = new Date().toISOString();
  const planType = next.planType ?? existing?.planType ?? null;
  const shouldClearSubscription = Boolean(options.clearSubscriptionIfNotSubscribed && !isSubscriptionPlan(planType));
  return {
    alias,
    email: next.email ?? existing?.email ?? null,
    planType,
    subscriptionExpiresAt: shouldClearSubscription ? null : next.subscriptionExpiresAt ?? existing?.subscriptionExpiresAt ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
}

function parseSubscriptionDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('订阅日期格式应为 YYYY-MM-DD，例如 cxa subsciption 2026-06-01。');
  }
  const date = new Date(`${value}T23:59:59`);
  if (Number.isNaN(date.getTime())) {
    throw new Error('订阅日期无效。');
  }
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) {
    throw new Error('订阅日期无效。');
  }
  return date.toISOString();
}

function isSubscriptionPlan(planType: string | null): boolean {
  if (planType === null) return false;
  return ['plus', 'pro', 'team', 'enterprise', 'business'].includes(planType.toLowerCase());
}

export function findSavedAccount(accounts: AccountSummary[], account: AcpAccountInfo): AccountSummary | null {
  if (account.email !== null) {
    const normalizedEmail = account.email.toLowerCase();
    return accounts.find((summary) => {
      return summary.alias.toLowerCase() === normalizedEmail || summary.meta?.email?.toLowerCase() === normalizedEmail;
    }) ?? null;
  }
  return accounts.find((summary) => summary.isActive) ?? null;
}

async function confirmAccountAlias(account: AcpAccountInfo, alias: string): Promise<void> {
  if (account.email !== null && account.email !== alias) {
    const ok = await confirm(`当前 Codex 登录账号是 ${account.email}，仍然保存为 ${alias} 吗？`);
    if (!ok) throw new Error('已取消添加。');
  }
}
