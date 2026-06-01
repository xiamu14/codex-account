import path from "node:path";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import chalk from "chalk";
import { readAcpAccount, readAcpSnapshotBestEffort } from "./acp.ts";
import { mergeAccountInfo, readAuthAccountInfo } from "./auth-jwt.ts";
import {
  AUTO_QUOTA_MAX_INTERVAL_MINUTES,
  AUTO_QUOTA_MIN_INTERVAL_MINUTES,
  migrateInvalidTokensFromAutoQuota,
  readAutoQuotaState,
  writeAutoQuotaState,
} from "./auto-quota.ts";
import { sortAccountsByUsagePriority } from "./account-priority.ts";
import {
  activateAuth,
  cleanupRunHome,
  hasCodexAuth,
  prepareAcpHome,
  runCodexCall,
  runCodexLogin,
} from "./codex.ts";
import { launchCodexDesktop, quitCodexDesktop } from "./desktop.ts";
import { copyFileAtomic, pathExists, readJsonIfExists, removePath, writeJsonAtomic } from "./fs.ts";
import { renderList } from "./format.ts";
import {
  isAccountMeta,
  isAccountQuota,
  isAccountsState,
  isAutoQuotaState,
} from "./guards.ts";
import { withLock } from "./lock.ts";
import {
  accountAuthPath,
  accountHome,
  accountMetaPath,
  accountQuotaPath,
  accountsRoot,
  accountsStatePath,
  autoQuotaStatePath,
  runsRoot,
} from "./paths.ts";
import {
  confirm,
  createSpinner,
  inputText,
  selectAlias,
  selectAliases,
} from "./prompt.ts";
import { runRefreshAuto } from "./refresh-auto.ts";
import {
  isAutoQuotaServiceRunning,
  recoverAutoQuotaServiceIfNeeded,
  startAutoQuotaService,
  stopAutoQuotaService,
} from "./service.ts";
import { AccountStore, assertAlias } from "./store.ts";
import type {
  AccountMeta,
  AccountSummary,
  AcpAccountInfo,
  CommandContext,
  AccountsState,
  AccountQuota,
  AutoQuotaState,
} from "./types.ts";

const CALL_MESSAGES = [
  "水杯",
  "书桌",
  "窗户",
  "铅笔",
  "纸张",
  "地图",
  "钟表",
  "椅子",
  "咖啡",
  "天气",
];
const AUTO_QUOTA_ACCOUNT_MIN_DELAY_MS = 5 * 60_000;
const AUTO_QUOTA_ACCOUNT_MAX_DELAY_MS = 6 * 60_000;
const QUOTA_REFRESH_MIN_DELAY_MS = 1_000;
const QUOTA_REFRESH_MAX_DELAY_MS = 5_000;
const AUTO_QUOTA_SERVICE_MIN_DELAY_MS =
  AUTO_QUOTA_MIN_INTERVAL_MINUTES * 60_000;
const AUTO_QUOTA_SERVICE_MAX_DELAY_MS =
  AUTO_QUOTA_MAX_INTERVAL_MINUTES * 60_000;
const DEFAULT_EXPORT_FILE = "codex-account-export.tar.gz";
const EXPORT_MARKER = ".codex-account-export.json";
const execFileAsync = promisify(execFile);

export async function exportCommand(
  context: CommandContext,
  file?: string,
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await store.loadState();
    const target = resolveTransferPath(context.cwd, file, DEFAULT_EXPORT_FILE);
    const stagingRoot = await mkdtemp(path.join(tmpdir(), "cxa-export-"));
    const staging = path.join(stagingRoot, ".codex-account");

    try {
      await prepareExportFile(target);
      await writeJsonAtomic(path.join(staging, EXPORT_MARKER), {
        version: 1,
        exportedAt: new Date().toISOString(),
      });
      await writeJsonAtomic(path.join(staging, "accounts.json"), state);
      if (await pathExists(accountsRoot(context.appHome))) {
        await cp(accountsRoot(context.appHome), path.join(staging, "accounts"), {
          recursive: true,
          force: true,
        });
      }
      if (await pathExists(autoQuotaStatePath(context.appHome))) {
        await copyFileAtomic(
          autoQuotaStatePath(context.appHome),
          path.join(staging, "auto-quota.json"),
        );
      }
      await createCompressedExport(stagingRoot, target);
    } finally {
      await removePath(stagingRoot);
    }

    context.stdout.write(
      `已导出 ${state.accounts.length} 个账号到 ${target}。\n`,
    );
  });
}

export async function importCommand(
  context: CommandContext,
  file?: string,
): Promise<void> {
  await withLock(context.appHome, async () => {
    const archive = resolveTransferPath(context.cwd, file, DEFAULT_EXPORT_FILE);
    const extractRoot = await mkdtemp(path.join(tmpdir(), "cxa-import-"));
    try {
      await extractCompressedExport(archive, extractRoot);
      const source = await resolveImportRoot(extractRoot);
      const importedState = await readImportState(source);
      const currentStore = new AccountStore(context.appHome);
      const currentState = await currentStore.loadState();
      const mergedAccounts = new Map(
        currentState.accounts.map((account) => [account.alias, account]),
      );

      for (const account of importedState.accounts) {
        assertAlias(account.alias);
        const sourceHome = path.join(source, "accounts", account.alias);
        const sourceAuth = path.join(sourceHome, "auth.json");
        if (!(await pathExists(sourceAuth))) {
          throw new Error(`导入失败：账号 ${account.alias} 缺少 auth.json。`);
        }
        await validateOptionalImportJson(
          path.join(sourceHome, "meta.json"),
          isAccountMeta,
          `账号 ${account.alias} 的 meta.json 格式不正确。`,
        );
        await validateOptionalImportJson(
          path.join(sourceHome, "quota.json"),
          isAccountQuota,
          `账号 ${account.alias} 的 quota.json 格式不正确。`,
        );
      }
      await validateOptionalImportJson(
        path.join(source, "auto-quota.json"),
        isAutoQuotaState,
        "auto-quota.json 格式不正确。",
      );

      for (const account of importedState.accounts) {
        const sourceHome = path.join(source, "accounts", account.alias);
        const sourceAuth = path.join(sourceHome, "auth.json");
        const targetHome = accountHome(context.appHome, account.alias);
        await removePath(targetHome);
        await mkdir(targetHome, { recursive: true });
        await copyFileAtomic(sourceAuth, accountAuthPath(context.appHome, account.alias));
        if (await pathExists(path.join(sourceHome, "meta.json"))) {
          await copyFileAtomic(
            path.join(sourceHome, "meta.json"),
            accountMetaPath(context.appHome, account.alias),
          );
        }
        if (await pathExists(path.join(sourceHome, "quota.json"))) {
          await copyFileAtomic(
            path.join(sourceHome, "quota.json"),
            accountQuotaPath(context.appHome, account.alias),
          );
        }
        mergedAccounts.set(account.alias, account);
      }

      const activeAccount =
        importedState.activeAccount !== null &&
        mergedAccounts.has(importedState.activeAccount)
          ? importedState.activeAccount
          : currentState.activeAccount;
      await writeJsonAtomic(accountsStatePath(context.appHome), {
        version: 1,
        accounts: [...mergedAccounts.values()],
        activeAccount,
        updatedAt: new Date().toISOString(),
      } satisfies AccountsState);

      if (await pathExists(path.join(source, "auto-quota.json"))) {
        await copyFileAtomic(
          path.join(source, "auto-quota.json"),
          autoQuotaStatePath(context.appHome),
        );
      }

      context.stdout.write(
        `已导入 ${importedState.accounts.length} 个账号。运行 bun cli list 查看。\n`,
      );
    } finally {
      await removePath(extractRoot);
    }
  });
}

export async function saveCommand(
  context: CommandContext,
  alias?: string,
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const liveAuth = path.join(context.codexHome, "auth.json");
    if (!(await hasCodexAuth(context.codexHome))) {
      throw new Error("当前未登录。请先运行 bun cli login。");
    }

    const account = mergeAccountInfo(
      await readAcpAccount(
        context.codexBin,
        context.codexHome,
        context.cwd,
      ),
      await readAuthAccountInfo(liveAuth),
    );
    const savedAccount = findSavedAccount(await store.listSummaries(), account);
    if (savedAccount !== null) {
      await store.writeMeta(mergeMeta(savedAccount.alias, savedAccount.meta, account));
      context.stdout.write(`当前账号已保存为 ${savedAccount.alias}。\n`);
      return;
    }

    const target =
      alias ??
      (await inputText(
        "请输入账号别名",
        account.email ?? "name@example.com",
        validateAlias,
      ));
    assertAlias(target);
    if (await store.hasAccount(target)) {
      context.stdout.write(`账号 ${target} 已保存。\n`);
      return;
    }
    await store.createAccount(target, liveAuth, account);
    await store.setActive(target);
    context.stdout.write(`已保存并激活 ${target}。\n`);
  });
}

export async function loginCommand(
  context: CommandContext,
  alias?: string,
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const target =
      alias ??
      (await inputText("请输入账号别名", "name@example.com", validateAlias));
    assertAlias(target);
    if (await store.hasAccount(target)) {
      context.stdout.write(`账号 ${target} 已保存。\n`);
      return;
    }

    await mkdir(runsRoot(context.appHome), { recursive: true });
    const loginHome = await mkdtemp(
      path.join(runsRoot(context.appHome), "login-"),
    );
    try {
      const loginAuth = path.join(loginHome, "auth.json");
      await runCodexLogin(context.codexBin, loginHome, context.cwd);
      if (!(await pathExists(loginAuth))) {
        throw new Error("登录失败：没有生成 auth.json。");
      }

      const account = mergeAccountInfo(
        await readAcpAccount(
          context.codexBin,
          loginHome,
          context.cwd,
        ),
        await readAuthAccountInfo(loginAuth),
      );
      const savedAccount = findSavedAccount(
        await store.listSummaries(),
        account,
      );
      if (savedAccount !== null) {
        await store.writeMeta(mergeMeta(savedAccount.alias, savedAccount.meta, account));
        context.stdout.write(
          `登录完成。账号已保存为 ${savedAccount.alias}。\n`,
        );
        return;
      }

      await store.createAccount(target, loginAuth, account);
      context.stdout.write(`已保存 ${target}。\n`);
    } finally {
      await cleanupRunHome(loginHome);
    }
  });
}

export async function listCommand(context: CommandContext): Promise<void> {
  const store = new AccountStore(context.appHome);
  context.stdout.write(`${renderList(await store.listSummaries())}\n`);
}

function resolveTransferPath(
  cwd: string,
  target: string | undefined,
  fallback: string,
): string {
  return path.resolve(cwd, target ?? fallback);
}

async function prepareExportFile(target: string): Promise<void> {
  if (await pathExists(target)) {
    await removePath(target);
  }
  await mkdir(path.dirname(target), { recursive: true });
}

async function createCompressedExport(
  stagingRoot: string,
  target: string,
): Promise<void> {
  try {
    await execFileAsync("tar", ["-czf", target, "-C", stagingRoot, ".codex-account"]);
  } catch (error) {
    throw new Error(`创建导出文件失败：${formatProcessError(error)}`);
  }
}

async function extractCompressedExport(
  archive: string,
  target: string,
): Promise<void> {
  if (!(await pathExists(archive))) {
    throw new Error(`导入文件不存在：${archive}`);
  }
  try {
    await execFileAsync("tar", ["-xzf", archive, "-C", target]);
  } catch (error) {
    throw new Error(`读取导入文件失败：${formatProcessError(error)}`);
  }
}

function formatProcessError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return "未知错误";
}

async function resolveImportRoot(target: string): Promise<string> {
  if (await pathExists(path.join(target, "accounts.json"))) {
    return target;
  }
  const nested = path.join(target, ".codex-account");
  if (await pathExists(path.join(nested, "accounts.json"))) {
    return nested;
  }
  throw new Error(`导入目录中没有 accounts.json：${target}`);
}

async function readImportState(source: string): Promise<AccountsState> {
  const parsed = await readJsonIfExists(path.join(source, "accounts.json"));
  if (!isAccountsState(parsed)) {
    throw new Error("导入失败：accounts.json 格式不正确。");
  }
  return parsed;
}

async function validateOptionalImportJson<T>(
  target: string,
  guard: (value: unknown) => value is T,
  message: string,
): Promise<void> {
  if (!(await pathExists(target))) return;
  const parsed = JSON.parse(await readFile(target, "utf8")) as unknown;
  if (!guard(parsed)) {
    throw new Error(message);
  }
}

export async function deleteCommand(
  context: CommandContext,
  alias?: string,
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await store.loadState();
    const target = requireAccountTarget(
      await resolveAccountTarget(state, alias, "删除"),
      "没有可删除的账号。",
    );
    await store.deleteAccount(target);
    context.stdout.write(`已删除 ${target}。\n`);
  });
}

export async function deactiveCommand(context: CommandContext): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    await quitCodexDesktop();
    await removePath(path.join(context.codexHome, "auth.json"));
    await store.setActive(null);
    context.stdout.write("已退出当前账号。\n");
  });
}

export async function activeCommand(
  context: CommandContext,
  alias?: string,
  options: { lockWaitMs?: number } = {},
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await store.loadState();
    const target = requireAccountTarget(
      await resolveAccountTarget(state, alias, "激活"),
      "没有可激活的账号。",
    );
    const authPath = await store.authPath(target);
    await quitCodexDesktop();
    await removePath(path.join(context.codexHome, "auth.json"));
    await activateAuth(authPath, context.codexHome);

    const account = mergeAccountInfo(
      await readAcpAccount(
        context.codexBin,
        context.codexHome,
        context.cwd,
      ),
      await readAuthAccountInfo(authPath),
    );
    const meta = await store.readMeta(target);
    await store.writeMeta(mergeMeta(target, meta, account));
    await store.setActive(target);
    await launchCodexDesktop();
    context.stdout.write(`已激活 ${target}。\n`);
  }, { waitMs: options.lockWaitMs });
}

export async function quotaCommand(
  context: CommandContext,
  options: { select?: boolean; aliases?: string[] } = {},
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await store.loadState();
    await migrateInvalidTokensFromAutoQuota(context.appHome, store);
    const summaries = await store.listSummaries();
    const invalidAliases = new Set(
      summaries
        .filter((account) => account.tokenStatus !== "valid")
        .map((account) => account.alias),
    );
    const allAliases = sortAccountsByUsagePriority(summaries).map(
      (account) => account.alias,
    );
    const requestedTargets =
      options.aliases ??
      (options.select === true
        ? await selectAliases(allAliases, "刷新额度")
        : allAliases);
    const skippedInvalidAliases = requestedTargets.filter((alias) =>
      invalidAliases.has(alias),
    );
    const targets = requestedTargets.filter(
      (alias) => !invalidAliases.has(alias),
    );
    if (targets.length === 0) {
      if (skippedInvalidAliases.length === 0) {
        throw new Error("没有账号可刷新。");
      }
      context.stderr.write(
        `已跳过 token 失效的账号：${skippedInvalidAliases.join(", ")}\n`,
      );
      const selected = (await store.listSummaries()).filter((summary) =>
        requestedTargets.includes(summary.alias),
      );
      context.stdout.write(`\n${renderList(selected)}\n`);
      return;
    }

    const failures: string[] = [];
    const warnings: string[] = [];
    const deactivatedAliases: string[] = [];
    for (const [index, alias] of targets.entries()) {
      await waitBeforeQuotaRefresh(index, targets.length);
      try {
        const result = await refreshAccountQuota(context, store, alias);
        if (result.quota !== null) {
          context.stdout.write(`已刷新 ${alias}\n`);
        } else {
          if (isTokenInvalidated(result.error)) {
            await markInvalidTokenAliases(store, [alias]);
            deactivatedAliases.push(alias);
          }
          warnings.push(formatQuotaWarning(alias, result.error));
          context.stdout.write(`已更新 ${alias}，额度未刷新。\n`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${alias}: ${message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`刷新失败：\n${failures.join("\n")}`);
    }
    if (warnings.length > 0) {
      context.stderr.write(`部分额度未刷新：\n${warnings.join("\n")}\n`);
    }
    if (deactivatedAliases.length > 0) {
      context.stderr.write(
        `已退出 token 失效的账号：${deactivatedAliases.join(", ")}\n`,
      );
    }
    if (skippedInvalidAliases.length > 0) {
      context.stderr.write(
        `已跳过 token 失效的账号：${skippedInvalidAliases.join(", ")}\n`,
      );
    }

    const updatedSummaries = await store.listSummaries();
    const selected = updatedSummaries.filter((summary) =>
      targets.includes(summary.alias),
    );
    context.stdout.write(`\n${renderList(selected)}\n`);
  });
}

export async function retryFailedQuotaCommand(
  context: CommandContext,
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const current = await readAutoQuotaState(context.appHome);
    await migrateInvalidTokensFromAutoQuota(context.appHome, store);
    const accountByAlias = new Map(
      (await store.listSummaries()).map((account) => [account.alias, account]),
    );
    const aliases = Object.keys(current.lastFailureByAlias).filter(
      (alias) => accountByAlias.get(alias)?.tokenStatus === "valid",
    );
    if (aliases.length === 0) {
      context.stdout.write("没有失败记录可重试。\n");
      return;
    }

    const now = new Date();
    const quotaFetches: string[] = [];
    const failures: Record<string, string> = {};
    const recoveredAliases: string[] = [];
    const invalidTokenAliases: string[] = [];

    for (const [index, alias] of aliases.entries()) {
      await waitBeforeQuotaRefresh(index, aliases.length);
      const result = await refreshQuotaQuietly(context, store, alias);
      if (result.quota === null) {
        if (isTokenInvalidated(result.error)) {
          logInvalidTokenFailure(context, alias, "retry-quota", result.error);
          invalidTokenAliases.push(alias);
          continue;
        }
        failures[alias] = formatAutoQuotaFailure(alias, result.error);
        context.stdout.write(`已重试 ${alias}，额度未刷新。\n`);
        continue;
      }
      quotaFetches.push(alias);
      recoveredAliases.push(alias);
      context.stdout.write(`已刷新 ${alias}\n`);
    }

    await writeAutoQuotaState(context.appHome, {
      ...current,
      lastTickAt: now.toISOString(),
      lastQuotaFetchAt:
        quotaFetches.length > 0 ? now.toISOString() : current.lastQuotaFetchAt,
      lastFailureByAlias: failures,
      consecutiveFailureCountByAlias: mergeFailureCounts(
        current.consecutiveFailureCountByAlias,
        failures,
        recoveredAliases,
      ),
      lastQuotaFetchAliases: quotaFetches,
    });
    await markInvalidTokenAliases(store, invalidTokenAliases);
  });
}

export async function callCommand(
  context: CommandContext,
  options: { select?: boolean; aliases?: string[] } = {},
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await store.loadState();
    const allAliases = state.accounts.map((account) => account.alias);
    const targets =
      options.aliases ??
      (options.select === true
        ? await selectAliases(allAliases, "call")
        : allAliases);
    if (targets.length === 0) {
      throw new Error("没有账号可 call。");
    }

    const calls = targets.map((target) => ({
      alias: target,
      message: pickCallMessage(),
    }));
    for (const call of calls) {
      context.stdout.write(`${call.alias}\n你：${call.message}\n`);
    }

    const wait = createSpinner(context.stdout);
    wait.start("等待回复");
    const results = await Promise.all(
      calls.map(async (call) => callAccount(context, store, call)),
    ).finally(() => {
      wait.stop("收到回复");
    });

    const successes = results.filter((result) => result.error === null);
    const failures = results.filter((result) => result.error !== null);

    for (const result of successes) {
      context.stdout.write(`${result.alias}\n回复：${result.reply}\n`);
    }
    if (failures.length > 0) {
      context.stderr.write(
        `部分账号失败：\n${failures
          .map((result) => `${result.alias}: ${result.error}`)
          .join("\n")}\n`,
      );
    }
    if (successes.length === 0 && failures.length > 0) {
      throw new Error("所有账号都失败。");
    }
  });
}

async function refreshAccountQuota(
  context: CommandContext,
  store: AccountStore,
  alias: string,
): Promise<{ quota: AccountQuota | null; error: string | null }> {
  let runHome: string | null = null;
  try {
    const authPath = await store.authPath(alias);
    const authAccount = await readAuthAccountInfo(authPath);
    runHome = await prepareAcpHome({
      appHome: context.appHome,
      codexHome: context.codexHome,
      authPath,
    });
    const snapshot = await readAcpSnapshotBestEffort(
      context.codexBin,
      runHome,
      context.cwd,
    );
    const [existingMeta, existingQuota] = await Promise.all([
      store.readMeta(alias),
      store.readQuota(alias),
    ]);
    const account = normalizeAccountPlanFromQuota(
      mergeAccountInfo(snapshot.account, authAccount),
      snapshot.quota ?? existingQuota,
      existingMeta?.planType ?? null,
    );
    await store.writeMeta(
      mergeMeta(alias, existingMeta, account, {
        overwritePlanTypeWithNull: true,
        clearSubscriptionIfNotSubscribed: true,
      }),
    );
    if (snapshot.quota !== null) {
      await store.writeQuota(alias, snapshot.quota);
      return { quota: snapshot.quota, error: null };
    }
    return { quota: null, error: snapshot.quotaError };
  } finally {
    if (runHome !== null) {
      await cleanupRunHome(runHome);
    }
  }
}

async function refreshQuotaQuietly(
  context: CommandContext,
  store: AccountStore,
  alias: string,
): Promise<{ quota: AccountQuota | null; error: string | null }> {
  try {
    return await refreshAccountQuota(context, store, alias);
  } catch (error) {
    return {
      quota: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function callAccount(
  context: CommandContext,
  store: AccountStore,
  call: { alias: string; message: string },
): Promise<{
  alias: string;
  message: string;
  reply: string | null;
  error: string | null;
  tokenInvalidated: boolean;
}> {
  let runHome: string | null = null;
  try {
    await store.requireAccount(call.alias);
    runHome = await prepareAcpHome({
      appHome: context.appHome,
      codexHome: context.codexHome,
      authPath: await store.authPath(call.alias),
    });
    const reply = await runCodexCall(
      context.codexBin,
      runHome,
      context.cwd,
      call.message,
    );
    return {
      alias: call.alias,
      message: call.message,
      reply,
      error: null,
      tokenInvalidated: false,
    };
  } catch (error) {
    const rawError = error instanceof Error ? error.message : String(error);
    return {
      alias: call.alias,
      message: call.message,
      reply: null,
      error: formatCallFailure(call.alias, error),
      tokenInvalidated: isTokenInvalidated(rawError),
    };
  } finally {
    if (runHome !== null) {
      await cleanupRunHome(runHome);
    }
  }
}

export async function autoQuotaStartCommand(
  context: CommandContext,
  options: {
    startService?: boolean;
    scriptPath?: string;
    bunBin?: string;
  } = {},
): Promise<void> {
  let startResult: {
    successes: string[];
    failures: Record<string, string>;
    invalidTokenAliases: string[];
  } = {
    successes: [],
    failures: {},
    invalidTokenAliases: [],
  };
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await readAutoQuotaState(context.appHome);
    await migrateInvalidTokensFromAutoQuota(context.appHome, store);
    startResult = await refreshAllQuotaForAutoStart(context, store);
    const now = new Date();
    await writeAutoQuotaState(context.appHome, {
      ...state,
      enabled: true,
      intervalMinutes: AUTO_QUOTA_MIN_INTERVAL_MINUTES,
      lastTickAt: now.toISOString(),
      nextCheckAt: new Date(
        now.getTime() +
          randomInt(
            AUTO_QUOTA_SERVICE_MIN_DELAY_MS,
            AUTO_QUOTA_SERVICE_MAX_DELAY_MS,
          ),
      ).toISOString(),
      lastQuotaFetchAt:
        startResult.successes.length > 0
          ? now.toISOString()
          : state.lastQuotaFetchAt,
      lastFailureByAlias: startResult.failures,
      consecutiveFailureCountByAlias: mergeFailureCounts(
        state.consecutiveFailureCountByAlias,
        startResult.failures,
        startResult.successes,
      ),
      lastQuotaFetchAliases: startResult.successes,
    });
    await markInvalidTokenAliases(store, startResult.invalidTokenAliases);
  });

  if (options.startService !== false) {
    await startAutoQuotaService({
      bunBin: options.bunBin ?? process.execPath,
      scriptPath:
        options.scriptPath ?? path.resolve(process.argv[1] ?? "src/main.ts"),
      cwd: context.cwd,
      appHome: context.appHome,
      codexHome: context.codexHome,
      codexBin: context.codexBin,
    });
  }

  context.stdout.write("自动刷新已开启。每 5-6 分钟检查一次。\n");
  if (startResult.successes.length > 0) {
    context.stdout.write("已刷新当前额度：\n");
    for (const alias of startResult.successes) {
      context.stdout.write(`  ${alias}\n`);
    }
  }
  const failures = Object.entries(startResult.failures);
  if (failures.length > 0) {
    context.stdout.write("失败账号：\n");
    for (const [alias, reason] of failures) {
      context.stdout.write(`  ${alias}：${reason}\n`);
    }
  }
}

async function refreshAllQuotaForAutoStart(
  context: CommandContext,
  store: AccountStore,
): Promise<{
  successes: string[];
  failures: Record<string, string>;
  invalidTokenAliases: string[];
}> {
  const sortedAliases = sortAccountsByUsagePriority(
    await store.listSummaries(),
  ).map((account) => account.alias);
  const successes: string[] = [];
  const failures: Record<string, string> = {};
  const invalidTokenAliases: string[] = [];
  for (const alias of sortedAliases) {
    const result = await refreshQuotaQuietly(context, store, alias);
    if (result.quota === null) {
      if (isTokenInvalidated(result.error)) {
        logInvalidTokenFailure(context, alias, "start-quota", result.error);
        invalidTokenAliases.push(alias);
        continue;
      }
      failures[alias] = formatAutoQuotaFailure(alias, result.error);
      continue;
    }
    successes.push(alias);
  }
  return { successes, failures, invalidTokenAliases };
}

export async function autoQuotaStopCommand(
  context: CommandContext,
  options: { stopService?: boolean } = {},
): Promise<void> {
  await withLock(context.appHome, async () => {
    const state = await readAutoQuotaState(context.appHome);
    await writeAutoQuotaState(context.appHome, {
      ...state,
      enabled: false,
      intervalMinutes: AUTO_QUOTA_MIN_INTERVAL_MINUTES,
    });

    if (options.stopService !== false) {
      await stopAutoQuotaService(context.appHome);
    }

    context.stdout.write("自动刷新已停止。\n");
  });
}

export async function autoQuotaStatusCommand(
  context: CommandContext,
  options: { recoverService?: boolean } = {},
): Promise<void> {
  const store = new AccountStore(context.appHome);
  const autoState = await readAutoQuotaState(context.appHome);
  const serviceStatus =
    options.recoverService === false
      ? {
          serviceRunning: await isAutoQuotaServiceRunning(context.appHome),
          recovered: false,
        }
      : await recoverAutoQuotaServiceIfNeeded(context, autoState);
  const summaries = await store.listSummaries();
  context.stdout.write(
    `${renderAutoQuotaStatus(autoState, serviceStatus.serviceRunning, summaries)}\n`,
  );
  if (serviceStatus.recovered) {
    context.stdout.write("后台服务已自动恢复。\n");
  }
}

export async function autoQuotaServiceCommand(
  context: CommandContext,
): Promise<void> {
  const stop = (): never => {
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (true) {
    const state = await readAutoQuotaState(context.appHome);
    if (!state.enabled) {
      await sleep(AUTO_QUOTA_SERVICE_MIN_DELAY_MS);
      continue;
    }

    const nowBeforeTick = new Date();
    const wakeStatus = resolveMissedCheckStatus(state, nowBeforeTick);
    if (wakeStatus !== null) {
      await writeAutoQuotaState(context.appHome, {
        ...state,
        lastWakeAt: nowBeforeTick.toISOString(),
        lastMissedCheckCount: wakeStatus.missedCheckCount,
      });
    }

    await autoQuotaTickCommand(context);
    const now = new Date();
    const delay = randomInt(
      AUTO_QUOTA_SERVICE_MIN_DELAY_MS,
      AUTO_QUOTA_SERVICE_MAX_DELAY_MS,
    );
    const nextCheckAt = await resolveNextAutoQuotaCheckAt(context, now, delay);
    await writeAutoQuotaState(context.appHome, {
      ...(await readAutoQuotaState(context.appHome)),
      nextCheckAt: nextCheckAt.toISOString(),
    });
    await sleep(Math.max(0, nextCheckAt.getTime() - Date.now()));
  }
}

function resolveMissedCheckStatus(
  state: AutoQuotaState,
  now: Date,
): { missedCheckCount: number } | null {
  if (state.nextCheckAt === null) return null;
  const nextCheckAt = new Date(state.nextCheckAt);
  if (Number.isNaN(nextCheckAt.getTime())) return null;
  const lateMs = now.getTime() - nextCheckAt.getTime();
  if (lateMs < AUTO_QUOTA_MIN_INTERVAL_MINUTES * 60_000) return null;
  return {
    missedCheckCount: Math.max(
      1,
      Math.floor(lateMs / (AUTO_QUOTA_MIN_INTERVAL_MINUTES * 60_000)),
    ),
  };
}

async function resolveNextAutoQuotaCheckAt(
  context: CommandContext,
  now: Date,
  randomDelayMs: number,
): Promise<Date> {
  const randomCheckAt = new Date(now.getTime() + randomDelayMs);
  const store = new AccountStore(context.appHome);
  const [accounts, state] = await Promise.all([
    store.listSummaries(),
    readAutoQuotaState(context.appHome),
  ]);
  const schedule = buildAutoQuotaSchedule(
    accounts
      .map((account) => ({
        alias: account.alias,
        reset: account.quota?.fiveHour?.resetsAt ?? null,
      }))
      .filter(
        (item): item is { alias: string; reset: string } => item.reset !== null,
      ),
  );

  let nextDueAt: Date | null = null;
  for (const account of accounts) {
    const reset = account.quota?.fiveHour?.resetsAt ?? null;
    if (
      reset === null ||
      state.handledFiveHourResets[account.alias] === reset
    ) {
      continue;
    }
    const dueAt = schedule.get(account.alias);
    if (dueAt === undefined || dueAt.getTime() <= now.getTime()) {
      continue;
    }
    if (nextDueAt === null || dueAt.getTime() < nextDueAt.getTime()) {
      nextDueAt = dueAt;
    }
  }

  if (nextDueAt !== null && nextDueAt.getTime() < randomCheckAt.getTime()) {
    return nextDueAt;
  }
  return randomCheckAt;
}

export async function autoQuotaTickCommand(
  context: CommandContext,
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const current = await readAutoQuotaState(context.appHome);
    await migrateInvalidTokensFromAutoQuota(context.appHome, store);
    if (!current.enabled) {
      return;
    }

    let now = new Date();
    const successes: string[] = [];
    const quotaFetches: string[] = [];
    const failures: Record<string, string> = {};
    const recoveredAliases: string[] = [];
    const invalidTokenAliases: string[] = [];
    const handledFiveHourResets = { ...current.handledFiveHourResets };
    const sortedAliases = sortAccountsByUsagePriority(
      await store.listSummaries(),
    ).map((account) => account.alias);
    const quotaByAlias = new Map<string, AccountQuota>();

    for (const [index, alias] of sortedAliases.entries()) {
      await waitBeforeQuotaRefresh(index, sortedAliases.length);
      const fetched = await refreshQuotaQuietly(context, store, alias);
      if (fetched.quota === null) {
        if (isTokenInvalidated(fetched.error)) {
          logInvalidTokenFailure(context, alias, "tick-quota", fetched.error);
          invalidTokenAliases.push(alias);
          continue;
        }
        failures[alias] = formatAutoQuotaFailure(alias, fetched.error);
        continue;
      }
      const quota = fetched.quota;
      pushUnique(quotaFetches, alias);
      recoveredAliases.push(alias);
      const reset = quota.fiveHour?.resetsAt ?? null;
      const resetTime = reset === null ? null : new Date(reset);
      if (
        reset === null ||
        resetTime === null ||
        Number.isNaN(resetTime.getTime())
      ) {
        failures[alias] = "缺少 5h 重置时间。";
        continue;
      }
      if (
        handledFiveHourResets[alias] !== undefined &&
        handledFiveHourResets[alias] !== reset
      ) {
        delete handledFiveHourResets[alias];
      }
      quotaByAlias.set(alias, quota);
    }

    const scheduleByAlias = buildAutoQuotaSchedule(
      [...quotaByAlias.entries()].map(([alias, quota]) => ({
        alias,
        reset: quota.fiveHour?.resetsAt ?? "",
      })),
    );

    for (const alias of sortedAliases) {
      if (!(await isAutoCallEligibleAccount(store, alias))) {
        continue;
      }
      const quota = quotaByAlias.get(alias);
      if (quota === undefined) continue;
      const resetValue = quota.fiveHour?.resetsAt ?? null;
      if (resetValue === null) continue;
      const dueAt = scheduleByAlias.get(alias);
      if (dueAt === undefined) continue;
      if (dueAt.getTime() > now.getTime()) {
        recoveredAliases.push(alias);
        continue;
      }
      if (handledFiveHourResets[alias] === resetValue) {
        continue;
      }
      await waitBeforeQuotaRefresh(successes.length, sortedAliases.length);

      const result = await callAccount(context, store, {
        alias,
        message: pickCallMessage(),
      });
      if (result.error !== null) {
        if (result.tokenInvalidated) {
          logInvalidTokenFailure(context, alias, "tick-call", result.error);
          invalidTokenAliases.push(alias);
          continue;
        }
        failures[alias] = result.error;
        continue;
      }

      successes.push(alias);
      recoveredAliases.push(alias);
      handledFiveHourResets[alias] = resetValue;
      const refreshed = await refreshQuotaQuietly(context, store, alias);
      if (refreshed.quota === null) {
        if (isTokenInvalidated(refreshed.error)) {
          logInvalidTokenFailure(
            context,
            alias,
            "tick-post-call-quota",
            refreshed.error,
          );
          invalidTokenAliases.push(alias);
          continue;
        }
        failures[alias] = "已发送刷新请求，但读取新额度失败。";
      } else {
        pushUnique(quotaFetches, alias);
        if (refreshed.quota.fiveHour?.resetsAt !== resetValue) {
          delete handledFiveHourResets[alias];
        }
      }
    }

    await writeAutoQuotaState(context.appHome, {
      ...current,
      intervalMinutes: AUTO_QUOTA_MIN_INTERVAL_MINUTES,
      lastTickAt: now.toISOString(),
      nextCheckAt: current.nextCheckAt,
      lastQuotaFetchAt:
        quotaFetches.length > 0 ? now.toISOString() : current.lastQuotaFetchAt,
      lastCallAt: successes.length > 0 ? now.toISOString() : current.lastCallAt,
      lastSuccessAliases: successes,
      lastFailureByAlias: failures,
      consecutiveFailureCountByAlias: mergeFailureCounts(
        current.consecutiveFailureCountByAlias,
        failures,
        recoveredAliases,
      ),
      lastQuotaFetchAliases: quotaFetches,
      handledFiveHourResets,
    });
    await markInvalidTokenAliases(store, invalidTokenAliases);
  });
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function mergeFailureCounts(
  current: Record<string, number>,
  failures: Record<string, string>,
  recoveredAliases: string[],
): Record<string, number> {
  const next = { ...current };
  for (const alias of recoveredAliases) {
    delete next[alias];
  }
  for (const alias of Object.keys(failures)) {
    next[alias] = (next[alias] ?? 0) + 1;
  }
  return next;
}

async function isAutoCallEligibleAccount(
  store: AccountStore,
  alias: string,
): Promise<boolean> {
  const meta = await store.readMeta(alias);
  const quota = await store.readQuota(alias);
  if (
    isStaleSubscriptionPlan(
      meta?.planType ?? null,
      meta?.subscriptionExpiresAt ?? null,
      quota,
    )
  ) {
    return false;
  }
  return isSubscriptionPlan(meta?.planType ?? null);
}

async function waitBeforeQuotaRefresh(
  index: number,
  total: number,
): Promise<void> {
  if (index === 0 || total <= 1) return;
  const override = process.env.CXA_QUOTA_REFRESH_DELAY_MS;
  if (override !== undefined) {
    const delay = Number.parseInt(override, 10);
    if (Number.isFinite(delay) && delay >= 0) {
      if (delay > 0) await sleep(delay);
      return;
    }
  }
  await sleep(
    randomInt(QUOTA_REFRESH_MIN_DELAY_MS, QUOTA_REFRESH_MAX_DELAY_MS),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export async function refreshCommand(
  context: CommandContext,
  options: string | { alias?: string; auto?: boolean; dryRun?: boolean } = {},
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await store.loadState();
    if (state.accounts.length === 0) {
      throw new Error("没有账号可刷新 token。");
    }
    const resolvedOptions =
      typeof options === "string" ? { alias: options } : options;
    if (resolvedOptions.auto === true) {
      await refreshInvalidTokenAccountAutomatically(context, store, {
        dryRun: resolvedOptions.dryRun === true,
      });
      return;
    }
    const target = requireAccountTarget(
      await resolveAccountTarget(state, resolvedOptions.alias, "刷新 token"),
      "请选择账号。",
    );

    await refreshTokenForTarget(context, store, target, null);
    context.stdout.write(`已刷新 ${target} 的 token。\n`);
  });
}

async function refreshInvalidTokenAccountAutomatically(
  context: CommandContext,
  store: AccountStore,
  options: { dryRun: boolean },
): Promise<void> {
  await migrateInvalidTokensFromAutoQuota(context.appHome, store);
  const summaries = await store.listSummaries();
  const targets = options.dryRun
    ? summaries
    : summaries.filter((account) => account.tokenStatus === "invalid");
  if (targets.length === 0) {
    context.stdout.write("没有 token 失效的账号需要自动刷新。\n");
    return;
  }
  const target =
    targets.length === 1
      ? targets[0]!.alias
      : await selectAlias(
          targets.map((account) => account.alias),
          options.dryRun ? "调试自动刷新" : "自动刷新 token",
        );
  const summary = targets.find((account) => account.alias === target);
  const email = summary?.meta?.email ?? emailFromAlias(target);

  if (options.dryRun) {
    await runRefreshAuto({
      appHome: context.appHome,
      account: { alias: target, email },
      authUrl: "about:blank",
      authReady: async () => false,
      stdout: context.stdout,
      dryRun: true,
      preflightOnly: true,
    });
    context.stdout.write(`自动刷新 dryRun 通过：${target}。\n`);
    return;
  }

  await runRefreshAuto({
    appHome: context.appHome,
    account: { alias: target, email },
    authUrl: "about:blank",
    authReady: async () => false,
    stdout: context.stdout,
    preflightOnly: true,
  });

  await refreshTokenForTarget(context, store, target, async (authUrl, refreshAuth) => {
    await runRefreshAuto({
      appHome: context.appHome,
      account: { alias: target, email },
      authUrl,
      authReady: async () => pathExists(refreshAuth),
      stdout: context.stdout,
      dryRun: false,
      skipProxyCheck: true,
    });
  });
  context.stdout.write(`已刷新 ${target} 的 token。\n`);

  const quota = await refreshAccountQuota(context, store, target);
  if (quota.quota !== null) {
    context.stdout.write(`已刷新 ${target} 的额度。\n`);
    return;
  }
  context.stderr.write(`额度刷新失败：${quota.error ?? "未知错误"}\n`);
}

async function refreshTokenForTarget(
  context: CommandContext,
  store: AccountStore,
  target: string,
  handleAuthUrl: ((authUrl: string, refreshAuth: string) => Promise<void>) | null,
): Promise<void> {
    await store.requireAccount(target);
    const existingMeta = await store.readMeta(target);
    const expectedEmail = existingMeta?.email ?? emailFromAlias(target);

    await mkdir(runsRoot(context.appHome), { recursive: true });
    const refreshHome = await mkdtemp(
      path.join(runsRoot(context.appHome), "refresh-"),
    );
    try {
      const refreshAuth = path.join(refreshHome, "auth.json");
      await runCodexLogin(
        context.codexBin,
        refreshHome,
        context.cwd,
        handleAuthUrl === null
          ? {}
          : {
              authCompletionGraceMs: 30_000,
              handleAuthUrl: (authUrl) => handleAuthUrl(authUrl, refreshAuth),
            },
      );
      if (!(await pathExists(refreshAuth))) {
        throw new Error("登录失败：没有生成 auth.json。");
      }

      const account = mergeAccountInfo(
        await readAcpAccount(
          context.codexBin,
          refreshHome,
          context.cwd,
        ),
        await readAuthAccountInfo(refreshAuth),
      );
      await assertRefreshTarget(target, expectedEmail, account);
      await store.replaceAuth(target, refreshAuth);
      await store.writeMeta(mergeMeta(target, existingMeta, account));
      await store.markTokenValid(target);
    } finally {
      await cleanupRunHome(refreshHome);
    }
}

export async function resolveAccountTarget(
  state: AccountsState,
  alias: string | undefined,
  action: string,
): Promise<string | null> {
  if (alias !== undefined) {
    return alias;
  }

  const aliases = state.accounts.map((account) => account.alias);
  if (aliases.length === 0) {
    return null;
  }
  if (aliases.length === 1) {
    return aliases[0]!;
  }
  return selectAlias(aliases, action);
}

function requireAccountTarget(target: string | null, message: string): string {
  if (target === null) {
    throw new Error(message);
  }
  return target;
}

function mergeMeta(
  alias: string,
  existing: AccountMeta | null,
  next: {
    email: string | null;
    planType: string | null;
    subscriptionExpiresAt: string | null;
  },
  options: {
    overwritePlanTypeWithNull?: boolean;
    clearSubscriptionIfNotSubscribed?: boolean;
  } = {},
): AccountMeta {
  const now = new Date().toISOString();
  const planType =
    next.planType ??
    (options.overwritePlanTypeWithNull ? "free" : (existing?.planType ?? null));
  const shouldClearSubscription = Boolean(
    options.clearSubscriptionIfNotSubscribed && !isSubscriptionPlan(planType),
  );
  return {
    alias,
    email: next.email ?? existing?.email ?? null,
    planType,
    subscriptionExpiresAt: shouldClearSubscription
      ? null
      : (next.subscriptionExpiresAt ?? existing?.subscriptionExpiresAt ?? null),
    tokenStatus: existing?.tokenStatus ?? "valid",
    tokenInvalidatedAt: existing?.tokenInvalidatedAt ?? null,
    tokenInvalidReason: existing?.tokenInvalidReason ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function validateAlias(value: string | undefined): string | undefined {
  try {
    if (value === undefined) return "请输入账号别名。";
    assertAlias(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function isSubscriptionPlan(planType: string | null): boolean {
  if (planType === null) return false;
  return ["plus", "pro", "team", "enterprise", "business"].includes(
    planType.toLowerCase(),
  );
}

function normalizeAccountPlanFromQuota(
  account: {
    email: string | null;
    planType: string | null;
    subscriptionExpiresAt: string | null;
  },
  quota: AccountQuota | null,
  existingPlanType: string | null = null,
): {
  email: string | null;
  planType: string | null;
  subscriptionExpiresAt: string | null;
} {
  if (
    isStaleSubscriptionPlan(
      account.planType,
      account.subscriptionExpiresAt,
      quota,
    )
  ) {
    return {
      ...account,
      planType: "free",
    };
  }
  if (
    !isSubscriptionPlan(account.planType) &&
    quota !== null &&
    hasUsableWeeklyQuota(quota)
  ) {
    return {
      ...account,
      planType: isSubscriptionPlan(existingPlanType) ? existingPlanType : "plus",
    };
  }
  return account;
}

function isStaleSubscriptionPlan(
  planType: string | null,
  subscriptionExpiresAt: string | null,
  quota: AccountQuota | null,
): boolean {
  return (
    quota !== null &&
    isSubscriptionPlan(planType) &&
    subscriptionExpiresAt === null &&
    !hasUsableWeeklyQuota(quota)
  );
}

function hasUsableWeeklyQuota(quota: AccountQuota): boolean {
  return (
    quota.weekly?.percentLeft !== null &&
    quota.weekly?.percentLeft !== undefined
  );
}

function formatQuotaWarning(alias: string, error: string | null): string {
  if (isTokenInvalidated(error)) {
    return `${alias}: token 已失效。运行 bun cli refresh ${alias}。`;
  }
  const firstLine = error
    ?.split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  return `${alias}: ${firstLine ?? "读取额度失败"}`;
}

function renderAutoQuotaStatus(
  state: AutoQuotaState,
  serviceRunning: boolean,
  summaries: AccountSummary[],
): string {
  if (!state.enabled) {
    return [
      `${chalk.bold("自动刷新：")}${chalk.yellow("未开启")}`,
      "",
      "当前不会自动刷新 5h quota。",
      "开启命令：",
      `  ${chalk.cyan("bun cli quota --start")}`,
    ].join("\n");
  }

  const lines = [
    `${chalk.bold("自动刷新：")}${chalk.green("已开启")}`,
    `${chalk.bold("检查频率：")}每 ${AUTO_QUOTA_MIN_INTERVAL_MINUTES}-${AUTO_QUOTA_MAX_INTERVAL_MINUTES} 分钟`,
    `${chalk.bold("后台服务：")}${serviceRunning ? chalk.green("正常") : chalk.red("未运行")}`,
    "",
    `${chalk.bold("上次检查：")}${chalk.dim(formatFriendlyTime(state.lastTickAt))}`,
    `${chalk.bold("下次检查：")}${chalk.dim(formatNextCheckTime(state))}`,
    `${chalk.bold("上次额度刷新：")}${chalk.dim(formatFriendlyTime(state.lastQuotaFetchAt))}`,
  ];

  if (state.lastCallAt !== null) {
    lines.push(
      `${chalk.bold("上次触发重置：")}${chalk.dim(formatFriendlyTime(state.lastCallAt))}`,
    );
    if (state.lastSuccessAliases.length > 0) {
      lines.push(`  ${chalk.green("已触发：")}`);
      for (const alias of state.lastSuccessAliases) {
        lines.push(`    ${chalk.green(alias)}`);
      }
    }
  } else {
    lines.push(`${chalk.bold("上次触发重置：")}${chalk.dim("暂无")}`);
  }

  if (state.lastQuotaFetchAliases.length > 0) {
    lines.push(`  ${chalk.cyan("已自动获取额度：")}`);
    for (const alias of state.lastQuotaFetchAliases) {
      lines.push(`    ${chalk.cyan(alias)}`);
    }
  }

  const failures = Object.entries(state.lastFailureByAlias);
  if (failures.length > 0) {
    lines.push("");
    lines.push(chalk.yellow(`失败账号：${failures.length} 个`));
    const width = maxTextWidth(failures.map(([alias]) => alias));
    for (const [alias, reason] of failures) {
      const count = state.consecutiveFailureCountByAlias[alias] ?? 1;
      const detail =
        count >= 3
          ? `${reason} 连续失败 ${count} 次，已暂停。修复后会自动恢复。`
          : `${reason} 连续失败 ${count} 次，下次再试。`;
      lines.push(
        `  ${chalk.yellow(padText(alias, width))}  ${chalk.dim(detail)}`,
      );
    }
    lines.push("");
    lines.push(chalk.dim("其他账号不受影响。"));
  }

  const nextRawItems = summaries
    .map((summary) => ({
      alias: summary.alias,
      reset: parseDate(summary.quota?.fiveHour?.resetsAt ?? null),
      rawReset: summary.quota?.fiveHour?.resetsAt ?? null,
    }))
    .filter(
      (item): item is { alias: string; reset: Date; rawReset: string } =>
        item.reset !== null && item.rawReset !== null,
    );
  const nextSchedule = buildAutoQuotaSchedule(
    nextRawItems.map((item) => ({ alias: item.alias, reset: item.rawReset })),
  );
  const priorityAliases = sortAccountsByUsagePriority(summaries).map(
    (summary) => summary.alias,
  );
  const priorityIndexByAlias = new Map(
    priorityAliases.map((alias, index) => [alias, index]),
  );
  const nextItems = nextRawItems
    .map((item) => ({
      alias: item.alias,
      reset: nextSchedule.get(item.alias) ?? item.reset,
    }))
    .sort(
      (left, right) =>
        (priorityIndexByAlias.get(left.alias) ?? Number.MAX_SAFE_INTEGER) -
          (priorityIndexByAlias.get(right.alias) ?? Number.MAX_SAFE_INTEGER) ||
        left.reset.getTime() - right.reset.getTime(),
    );

  if (nextItems.length > 0) {
    lines.push("");
    lines.push(chalk.bold("下次预计："));
    const width = maxTextWidth(nextItems.map((item) => item.alias));
    for (const item of nextItems) {
      const suffix = `${formatFriendlyTime(item.reset.toISOString())} 后刷新`;
      lines.push(`  ${padText(item.alias, width)}  ${chalk.cyan(suffix)}`);
    }
  }

  if (!serviceRunning) {
    lines.push("");
    lines.push(chalk.red("后台服务未运行。请重新开启："));
    lines.push(`  ${chalk.cyan("bun cli quota --start")}`);
  } else if (failures.length === 0) {
    lines.push("");
    lines.push(chalk.green("状态正常。"));
  }

  return lines.join("\n");
}

function formatAutoQuotaFailure(alias: string, error: string | null): string {
  if (isTokenInvalidated(error)) {
    return `token 已失效，请运行 bun cli refresh ${alias}`;
  }
  return "读取额度失败。";
}

function parseDate(value: string | null): Date | null {
  if (value === null || value.trim().length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildAutoQuotaSchedule(
  items: Array<{ alias: string; reset: string }>,
): Map<string, Date> {
  const groups = new Map<string, Array<{ alias: string; reset: string }>>();
  for (const item of items) {
    const group = groups.get(item.reset) ?? [];
    group.push(item);
    groups.set(item.reset, group);
  }

  const schedule = new Map<string, Date>();
  for (const [reset, group] of groups.entries()) {
    const base = new Date(reset);
    if (Number.isNaN(base.getTime())) continue;
    for (const item of group) {
      const offsetMs = stableRandomInt(
        `${item.alias}:${reset}:offset`,
        AUTO_QUOTA_ACCOUNT_MIN_DELAY_MS,
        AUTO_QUOTA_ACCOUNT_MAX_DELAY_MS,
      );
      schedule.set(item.alias, new Date(base.getTime() + offsetMs));
    }
  }
  return schedule;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function stableRandomInt(value: string, min: number, max: number): number {
  return min + (stableHash(value) % (max - min + 1));
}

function maxTextWidth(values: string[]): number {
  return values.reduce((max, value) => Math.max(max, textWidth(value)), 0);
}

function padText(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - textWidth(value)))}`;
}

function textWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += char.codePointAt(0)! > 0xff ? 2 : 1;
  }
  return width;
}

function formatFriendlyTime(value: string | null): string {
  const date = parseDate(value);
  if (date === null) return "还没有记录";
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfDate = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
  const dayDelta = Math.round((startOfDate - startOfToday) / 86_400_000);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (dayDelta === 0) return `今天 ${time}`;
  if (dayDelta === 1) return `明天 ${time}`;
  if (dayDelta === -1) return `昨天 ${time}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function formatNextCheckTime(state: AutoQuotaState): string {
  if (state.nextCheckAt !== null) {
    const nextCheckAt = parseDate(state.nextCheckAt);
    if (nextCheckAt === null) return "还没有记录";
    if (nextCheckAt.getTime() <= Date.now()) return "后台服务异常";
    return formatFriendlyTime(state.nextCheckAt);
  }
  if (!state.enabled || state.lastTickAt === null) return "还没有记录";
  const lastTickAt = parseDate(state.lastTickAt);
  if (lastTickAt === null) return "还没有记录";
  const min = new Date(
    lastTickAt.getTime() + AUTO_QUOTA_MIN_INTERVAL_MINUTES * 60_000,
  );
  const max = new Date(
    lastTickAt.getTime() + AUTO_QUOTA_MAX_INTERVAL_MINUTES * 60_000,
  );
  return `${formatFriendlyTime(min.toISOString())} - ${formatFriendlyTime(max.toISOString())}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function isTokenInvalidated(error: string | null): boolean {
  const lower = error?.toLowerCase() ?? "";
  return Boolean(
    lower.includes("token_invalidated") ||
      lower.includes("token has been invalidated") ||
      lower.includes("token_expired") ||
      lower.includes("authentication token is expired") ||
      lower.includes("refresh_token_reused") ||
      lower.includes("refresh token was already used") ||
      lower.includes("token 已失效") ||
      lower.includes("invalid token"),
  );
}

async function markInvalidTokenAliases(
  store: AccountStore,
  aliases: string[],
): Promise<void> {
  if (aliases.length === 0) return;
  for (const alias of aliases) {
    await store.markTokenInvalid(alias, "token 已失效");
  }
}

function logInvalidTokenFailure(
  context: CommandContext,
  alias: string,
  stage: string,
  error: string | null,
): void {
  context.stderr.write(
    `${JSON.stringify({
      level: "warn",
      event: "token_invalidated",
      alias,
      stage,
      error,
      at: new Date().toISOString(),
    })}\n`,
  );
}

function pickCallMessage(): string {
  return CALL_MESSAGES[Math.floor(Math.random() * CALL_MESSAGES.length)]!;
}

function formatCallFailure(alias: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isTokenInvalidated(message) || isAuthFailure(message)) {
    return `token 已失效。运行 bun cli refresh ${alias}。`;
  }
  if (isQuotaFailure(message)) {
    return "没有可用额度。";
  }
  return firstMeaningfulLine(message);
}

function isAuthFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("auth required") ||
    lower.includes("not logged in") ||
    lower.includes("login required") ||
    lower.includes("authentication") ||
    lower.includes("session expired")
  );
}

function isQuotaFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("usage limit reached") ||
    lower.includes("usage limit") ||
    lower.includes("workspace credit limit") ||
    lower.includes("credit limit") ||
    lower.includes("out of credits") ||
    lower.includes("reached your") ||
    lower.includes("rate limit") ||
    lower.includes("quota")
  );
}

function firstMeaningfulLine(message: string): string {
  return (
    message
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? "未知错误"
  );
}

function emailFromAlias(alias: string): string | null {
  return alias.includes("@") ? alias : null;
}

async function assertRefreshTarget(
  alias: string,
  expectedEmail: string | null,
  account: AcpAccountInfo,
): Promise<void> {
  if (expectedEmail !== null) {
    if (account.email === null) {
      throw new Error(`无法确认账号是否为 ${expectedEmail}，已取消。`);
    }
    if (account.email.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new Error(
        `登录的是 ${account.email}，不是 ${expectedEmail}。已取消。`,
      );
    }
    return;
  }

  if (account.email !== null) {
    const ok = await confirm(`用 ${account.email} 刷新 ${alias}？`);
    if (!ok) throw new Error("已取消。");
  }
}

export function findSavedAccount(
  accounts: AccountSummary[],
  account: AcpAccountInfo,
): AccountSummary | null {
  if (account.email !== null) {
    const normalizedEmail = account.email.toLowerCase();
    return (
      accounts.find((summary) => {
        return (
          summary.alias.toLowerCase() === normalizedEmail ||
          summary.meta?.email?.toLowerCase() === normalizedEmail
        );
      }) ?? null
    );
  }
  return accounts.find((summary) => summary.isActive) ?? null;
}
