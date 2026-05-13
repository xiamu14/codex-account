import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import chalk from "chalk";
import dayjs from "dayjs";
import { readAcpAccount, readAcpSnapshotBestEffort } from "./acp.ts";
import {
  AUTO_QUOTA_INTERVAL_MINUTES,
  readAutoQuotaState,
  writeAutoQuotaState,
} from "./auto-quota.ts";
import {
  activateAuth,
  cleanupRunHome,
  hasCodexAuth,
  prepareAcpHome,
  runCodexCall,
  runCodexLogin,
} from "./codex.ts";
import { launchCodexDesktop, quitCodexDesktop } from "./desktop.ts";
import { pathExists, removePath } from "./fs.ts";
import {
  installAutoQuotaLaunchAgent,
  isAutoQuotaLaunchAgentInstalled,
  uninstallAutoQuotaLaunchAgent,
} from "./launchd.ts";
import { renderList } from "./format.ts";
import { withLock } from "./lock.ts";
import { runsRoot } from "./paths.ts";
import { confirm, createSpinner, inputText, selectAlias, selectAliases } from "./prompt.ts";
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

export async function saveCommand(
  context: CommandContext,
  alias?: string,
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const liveAuth = path.join(context.codexHome, "auth.json");
    if (!(await hasCodexAuth(context.codexHome))) {
      throw new Error("当前 Codex 没有登录。请先运行 cxa login。");
    }

    const account = await readAcpAccount(
      context.codexBin,
      context.codexHome,
      context.cwd,
    );
    const savedAccount = findSavedAccount(
      await store.listSummaries(),
      account,
    );
    if (savedAccount !== null) {
      context.stdout.write(
        `当前登录账号已保存为 ${savedAccount.alias}，没有添加新账号。\n`,
      );
      return;
    }

    const target = alias ?? await inputText(
      "请输入账号别名",
      account.email ?? "name@example.com",
      validateAlias,
    );
    assertAlias(target);
    if (await store.hasAccount(target)) {
      context.stdout.write(`账号 ${target} 已保存，没有添加新账号。\n`);
      return;
    }
    await store.createAccount(target, liveAuth, account);
    await store.setActive(target);
    context.stdout.write(`已保存并激活账号 ${target}。\n`);
  });
}

export async function loginCommand(
  context: CommandContext,
  alias?: string,
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const target = alias ?? await inputText(
      "请输入账号别名",
      "name@example.com",
      validateAlias,
    );
    assertAlias(target);
    if (await store.hasAccount(target)) {
      context.stdout.write(`账号 ${target} 已保存，没有添加新账号。\n`);
      return;
    }

    await mkdir(runsRoot(context.appHome), { recursive: true });
    const loginHome = await mkdtemp(path.join(runsRoot(context.appHome), "login-"));
    try {
      const loginAuth = path.join(loginHome, "auth.json");
      await runCodexLogin(context.codexBin, loginHome, context.cwd);
      if (!(await pathExists(loginAuth))) {
        throw new Error("登录完成后没有生成 auth.json。");
      }

      const account = await readAcpAccount(
        context.codexBin,
        loginHome,
        context.cwd,
      );
      const savedAccount = findSavedAccount(
        await store.listSummaries(),
        account,
      );
      if (savedAccount !== null) {
        context.stdout.write(
          `登录完成。该账号已保存为 ${savedAccount.alias}，没有添加新账号。\n`,
        );
        return;
      }

      await store.createAccount(target, loginAuth, account);
      context.stdout.write(`登录完成，已保存账号 ${target}。\n`);
    } finally {
      await cleanupRunHome(loginHome);
    }
  });
}

export async function listCommand(context: CommandContext): Promise<void> {
  const store = new AccountStore(context.appHome);
  context.stdout.write(`${renderList(await store.listSummaries())}\n`);
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
    context.stdout.write(`已删除账号 ${target}。\n`);
  });
}

export async function deactiveCommand(context: CommandContext): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    await quitCodexDesktop();
    await removePath(path.join(context.codexHome, "auth.json"));
    await store.setActive(null);
    context.stdout.write("已退出当前 Codex 账号。\n");
  });
}

export async function activeCommand(
  context: CommandContext,
  alias?: string,
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

    const account = await readAcpAccount(
      context.codexBin,
      context.codexHome,
      context.cwd,
    );
    const meta = await store.readMeta(target);
    await store.writeMeta(mergeMeta(target, meta, account));
    await store.setActive(target);
    await launchCodexDesktop();
    context.stdout.write(`已激活账号 ${target}。\n`);
  });
}

export async function quotaCommand(
  context: CommandContext,
  options: { select?: boolean; aliases?: string[] } = {},
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await store.loadState();
    const allAliases = state.accounts.map((account) => account.alias);
    const targets = options.aliases ?? (
      options.select === true
        ? await selectAliases(allAliases, "刷新额度")
        : allAliases
    );
    if (targets.length === 0) {
      throw new Error("没有账号可刷新。");
    }

    const failures: string[] = [];
    const warnings: string[] = [];
    const deactivatedAliases: string[] = [];
    for (const alias of targets) {
      try {
        const result = await refreshAccountQuota(context, store, alias);
        if (result.quota !== null) {
          context.stdout.write(`已刷新 ${alias}\n`);
        } else {
          if (state.activeAccount === alias && isTokenInvalidated(result.error)) {
            await store.setActive(null);
            deactivatedAliases.push(alias);
          }
          warnings.push(formatQuotaWarning(alias, result.error));
          context.stdout.write(`已刷新 ${alias}，额度读取失败，已保留旧额度。\n`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${alias}: ${message}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`部分账号刷新失败：\n${failures.join("\n")}`);
    }
    if (warnings.length > 0) {
      context.stderr.write(`部分账号额度读取失败，账号信息已更新，旧额度已保留：\n${warnings.join("\n")}\n`);
    }
    if (deactivatedAliases.length > 0) {
      context.stderr.write(`token 失效的 active 账号已自动 deactive：${deactivatedAliases.join(", ")}\n`);
    }

    const summaries = await store.listSummaries();
    const selected = summaries.filter((summary) => targets.includes(summary.alias));
    context.stdout.write(`\n${renderList(selected)}\n`);
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
    const targets = options.aliases ?? (
      options.select === true
        ? await selectAliases(allAliases, "call")
        : allAliases
    );
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
    wait.start("等待回复...");
    const results = await Promise.all(
      calls.map(async (call) => callAccount(context, store, call)),
    ).finally(() => {
      wait.stop("收到回复。");
    });

    const successes = results.filter((result) => result.error === null);
    const failures = results.filter((result) => result.error !== null);

    for (const result of successes) {
      context.stdout.write(`${result.alias}\n回复：${result.reply}\n`);
    }
    if (failures.length > 0) {
      context.stderr.write(
        `部分账号 call 失败：\n${failures
          .map((result) => `${result.alias}: ${result.error}`)
          .join("\n")}\n`,
      );
    }
    if (successes.length === 0 && failures.length > 0) {
      throw new Error("所有账号 call 失败。");
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
    runHome = await prepareAcpHome({
      appHome: context.appHome,
      codexHome: context.codexHome,
      authPath: await store.authPath(alias),
    });
    const snapshot = await readAcpSnapshotBestEffort(
      context.codexBin,
      runHome,
      context.cwd,
    );
    await store.writeMeta(
      mergeMeta(alias, await store.readMeta(alias), snapshot.account, {
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
): Promise<{ alias: string; message: string; reply: string | null; error: string | null }> {
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
    return { alias: call.alias, message: call.message, reply, error: null };
  } catch (error) {
    return {
      alias: call.alias,
      message: call.message,
      reply: null,
      error: formatCallFailure(call.alias, error),
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
    installLaunchAgent?: boolean;
    scriptPath?: string;
    bunBin?: string;
  } = {},
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await readAutoQuotaState(context.appHome);
    const startResult = await refreshAllQuotaForAutoStart(context, store);
    await writeAutoQuotaState(context.appHome, {
      ...state,
      enabled: true,
      intervalMinutes: AUTO_QUOTA_INTERVAL_MINUTES,
      lastTickAt: new Date().toISOString(),
      lastFailureByAlias: startResult.failures,
      consecutiveFailureCountByAlias: mergeFailureCounts(
        state.consecutiveFailureCountByAlias,
        startResult.failures,
        startResult.successes,
      ),
      lastQuotaFetchAliases: startResult.successes,
    });

    if (options.installLaunchAgent !== false) {
      await installAutoQuotaLaunchAgent({
        bunBin: options.bunBin ?? process.execPath,
        scriptPath: options.scriptPath ?? path.resolve(process.argv[1] ?? "src/main.ts"),
        cwd: context.cwd,
        appHome: context.appHome,
        codexHome: context.codexHome,
        codexBin: context.codexBin,
      });
    }

    context.stdout.write("已开启 5h quota 自动刷新。后台会每 30 分钟检查一次。\n");
    if (startResult.successes.length > 0) {
      context.stdout.write("已先刷新当前额度：\n");
      for (const alias of startResult.successes) {
        context.stdout.write(`  ${alias}\n`);
      }
    }
    const failures = Object.entries(startResult.failures);
    if (failures.length > 0) {
      context.stdout.write("有些账号暂时无法读取额度，后台会继续重试：\n");
      for (const [alias, reason] of failures) {
        context.stdout.write(`  ${alias}：${reason}\n`);
      }
    }
  });
}

async function refreshAllQuotaForAutoStart(
  context: CommandContext,
  store: AccountStore,
): Promise<{ successes: string[]; failures: Record<string, string> }> {
  const state = await store.loadState();
  const successes: string[] = [];
  const failures: Record<string, string> = {};
  for (const account of state.accounts) {
    const result = await refreshQuotaQuietly(context, store, account.alias);
    if (result.quota === null) {
      failures[account.alias] = formatAutoQuotaFailure(account.alias, result.error);
      continue;
    }
    successes.push(account.alias);
  }
  return { successes, failures };
}

export async function autoQuotaStopCommand(
  context: CommandContext,
  options: { uninstallLaunchAgent?: boolean } = {},
): Promise<void> {
  await withLock(context.appHome, async () => {
    const state = await readAutoQuotaState(context.appHome);
    await writeAutoQuotaState(context.appHome, {
      ...state,
      enabled: false,
      intervalMinutes: AUTO_QUOTA_INTERVAL_MINUTES,
    });

    if (options.uninstallLaunchAgent !== false) {
      await uninstallAutoQuotaLaunchAgent();
    }

    context.stdout.write("已停止 5h quota 自动刷新。\n");
  });
}

export async function autoQuotaStatusCommand(context: CommandContext): Promise<void> {
  const store = new AccountStore(context.appHome);
  const autoState = await readAutoQuotaState(context.appHome);
  const installed = await isAutoQuotaLaunchAgentInstalled();
  const summaries = await store.listSummaries();
  context.stdout.write(`${renderAutoQuotaStatus(autoState, installed, summaries)}\n`);
}

export async function autoQuotaTickCommand(context: CommandContext): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const current = await readAutoQuotaState(context.appHome);
    if (!current.enabled) {
      return;
    }

    const now = new Date();
    const successes: string[] = [];
    const quotaFetches: string[] = [];
    const failures: Record<string, string> = {};
    const recoveredAliases: string[] = [];
    const handledFiveHourResets = { ...current.handledFiveHourResets };
    const state = await store.loadState();

    for (const account of state.accounts) {
      const alias = account.alias;
      let quota = await store.readQuota(alias);
      if (needsAutoQuotaFetch(quota)) {
        const fetched = await refreshQuotaQuietly(context, store, alias);
        if (fetched.quota === null) {
          failures[alias] = formatAutoQuotaFailure(alias, fetched.error);
          continue;
        }
        quota = fetched.quota;
        quotaFetches.push(alias);
        recoveredAliases.push(alias);
      }
      if (quota === null) {
        failures[alias] = "暂时无法读取额度，后台会继续重试。";
        continue;
      }

      const reset = quota.fiveHour?.resetsAt ?? null;
      const resetTime = reset === null ? null : new Date(reset);
      if (reset === null || resetTime === null || Number.isNaN(resetTime.getTime())) {
        failures[alias] = "暂时无法确认 5h quota 的重置时间，后台会继续重试。";
        continue;
      }
      const resetValue = reset;
      if (resetTime.getTime() > now.getTime()) {
        recoveredAliases.push(alias);
        continue;
      }
      const percentLeft = quota.fiveHour?.percentLeft ?? null;
      if (percentLeft === null) {
        failures[alias] = "暂时无法确认 5h quota 剩余额度，后台会继续重试。";
        continue;
      }
      if (percentLeft >= 90) {
        recoveredAliases.push(alias);
        continue;
      }
      if (handledFiveHourResets[alias] === resetValue) {
        continue;
      }

      const result = await callAccount(context, store, {
        alias,
        message: pickCallMessage(),
      });
      if (result.error !== null) {
        failures[alias] = result.error;
        continue;
      }

      successes.push(alias);
      recoveredAliases.push(alias);
      handledFiveHourResets[alias] = resetValue;
      const refreshed = await refreshQuotaQuietly(context, store, alias);
      if (refreshed.quota === null) {
        failures[alias] = "已发送刷新请求，但暂时无法读取新的额度，后台会继续重试。";
      }
    }

    await writeAutoQuotaState(context.appHome, {
      ...current,
      intervalMinutes: AUTO_QUOTA_INTERVAL_MINUTES,
      lastTickAt: now.toISOString(),
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
  });
}

function needsAutoQuotaFetch(quota: AccountQuota | null): boolean {
  return quota === null ||
    quota.fiveHour === null ||
    quota.fiveHour.resetsAt === null ||
    quota.fiveHour.percentLeft === null;
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

export async function refreshCommand(
  context: CommandContext,
  alias?: string,
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await store.loadState();
    if (state.accounts.length === 0) {
      throw new Error("没有账号可刷新 token。");
    }
    const target = requireAccountTarget(
      await resolveAccountTarget(state, alias, "刷新 token"),
      "请提供账号别名，或先运行 cxa active <alias>。",
    );

    await store.requireAccount(target);
    const existingMeta = await store.readMeta(target);
    const expectedEmail = existingMeta?.email ?? emailFromAlias(target);

    await mkdir(runsRoot(context.appHome), { recursive: true });
    const refreshHome = await mkdtemp(path.join(runsRoot(context.appHome), "refresh-"));
    try {
      const refreshAuth = path.join(refreshHome, "auth.json");
      await runCodexLogin(context.codexBin, refreshHome, context.cwd);
      if (!(await pathExists(refreshAuth))) {
        throw new Error("登录完成后没有生成 auth.json。");
      }

      const account = await readAcpAccount(
        context.codexBin,
        refreshHome,
        context.cwd,
      );
      await assertRefreshTarget(target, expectedEmail, account);
      await store.replaceAuth(target, refreshAuth);
      await store.writeMeta(mergeMeta(target, existingMeta, account));
    } finally {
      await cleanupRunHome(refreshHome);
    }

    context.stdout.write(`已刷新 ${target} 的 token。\n`);
  });
}

export async function subscriptionCommand(context: CommandContext): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await store.loadState();
    if (state.accounts.length === 0) {
      throw new Error("没有账号可更新订阅日期。");
    }
    const target = requireAccountTarget(
      await resolveAccountTarget(state, undefined, "更新订阅日期"),
      "没有可更新订阅日期的账号。",
    );
    const dateText = await inputText(
      "请输入订阅到期日期",
      "May 17, 2026",
      validateSubscriptionDate,
    );
    await updateSubscriptionDate(store, target, dateText);
    context.stdout.write(`已更新 ${target} 的订阅到期日期为 ${dateText}。\n`);
  });
}

export async function updateSubscriptionDateCommand(
  context: CommandContext,
  dateText: string,
  alias?: string,
): Promise<void> {
  await withLock(context.appHome, async () => {
    const store = new AccountStore(context.appHome);
    const state = await store.loadState();
    if (state.accounts.length === 0) {
      throw new Error("没有账号可更新订阅日期。");
    }
    const target = requireAccountTarget(
      await resolveAccountTarget(state, alias, "更新订阅日期"),
      "没有可更新订阅日期的账号。",
    );
    await updateSubscriptionDate(store, target, dateText);
    context.stdout.write(`已更新 ${target} 的订阅到期日期为 ${dateText}。\n`);
  });
}

async function updateSubscriptionDate(
  store: AccountStore,
  alias: string,
  dateText: string,
): Promise<void> {
  const subscriptionExpiresAt = parseSubscriptionDate(dateText);
  await store.requireAccount(alias);
  const meta = await store.readMeta(alias);
  const now = new Date().toISOString();
  await store.writeMeta({
    alias,
    email: meta?.email ?? null,
    planType: meta?.planType ?? null,
    subscriptionExpiresAt,
    createdAt: meta?.createdAt ?? now,
    updatedAt: now,
  });
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

function requireAccountTarget(
  target: string | null,
  message: string,
): string {
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
  options: { clearSubscriptionIfNotSubscribed?: boolean } = {},
): AccountMeta {
  const now = new Date().toISOString();
  const planType = next.planType ?? existing?.planType ?? null;
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
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

function parseSubscriptionDate(value: string): string {
  const date = dayjs(value.trim());
  if (!date.isValid()) {
    throw new Error("订阅日期无效。");
  }
  return date.endOf("day").toDate().toISOString();
}

function validateSubscriptionDate(value: string | undefined): string | undefined {
  try {
    if (value === undefined) return "请输入订阅日期。";
    parseSubscriptionDate(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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

function formatQuotaWarning(alias: string, error: string | null): string {
  if (isTokenInvalidated(error)) {
    return `${alias}: token 已失效。运行 cxa refresh ${alias} 后重新登录。`;
  }
  const firstLine = error?.split(/\r?\n/).find((line) => line.trim().length > 0);
  return `${alias}: ${firstLine ?? "ACP 读取额度信息失败"}`;
}

function renderAutoQuotaStatus(
  state: AutoQuotaState,
  launchAgentInstalled: boolean,
  summaries: AccountSummary[],
): string {
  if (!state.enabled) {
    return [
      `${chalk.bold("自动刷新：")}${chalk.yellow("未开启")}`,
      "",
      "不会自动刷新 5h quota。",
      "如需开启，请运行：",
      `  ${chalk.cyan("bun cli quota --start")}`,
    ].join("\n");
  }

  const lines = [
    `${chalk.bold("自动刷新：")}${chalk.green("已开启")}`,
    `${chalk.bold("检查频率：")}每 ${state.intervalMinutes} 分钟`,
    `${chalk.bold("后台任务：")}${launchAgentInstalled ? chalk.green("正常") : chalk.red("未安装")}`,
    "",
    `${chalk.bold("上次检查：")}${chalk.dim(formatFriendlyTime(state.lastTickAt))}`,
  ];

  if (state.lastCallAt !== null) {
    lines.push(`${chalk.bold("上次自动刷新：")}${chalk.dim(formatFriendlyTime(state.lastCallAt))}`);
    if (state.lastSuccessAliases.length > 0) {
      lines.push(`  ${chalk.green("已刷新：")}`);
      for (const alias of state.lastSuccessAliases) {
        lines.push(`    ${chalk.green(alias)}`);
      }
    }
  } else {
    lines.push(`${chalk.bold("上次自动刷新：")}${chalk.dim("还没有自动刷新过账号")}`);
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
    lines.push(chalk.yellow(`有 ${failures.length} 个账号暂时无法自动刷新：`));
    const width = maxTextWidth(failures.map(([alias]) => alias));
    for (const [alias, reason] of failures) {
      const count = state.consecutiveFailureCountByAlias[alias] ?? 1;
      const detail = count >= 3
        ? `${reason} 已连续失败 ${count} 次，先暂时放到一边；修复后下次检查会自动恢复。`
        : `${reason} 后台还会继续重试，已连续失败 ${count} 次。`;
      lines.push(`  ${chalk.yellow(padText(alias, width))}  ${chalk.dim(detail)}`);
    }
    lines.push("");
    lines.push(chalk.dim("其他账号会继续自动检查。"));
  }

  const nextItems = summaries
    .map((summary) => ({
      alias: summary.alias,
      reset: parseDate(summary.quota?.fiveHour?.resetsAt ?? null),
      percentLeft: summary.quota?.fiveHour?.percentLeft ?? null,
    }))
    .filter((item): item is { alias: string; reset: Date; percentLeft: number | null } => item.reset !== null)
    .sort((left, right) => left.reset.getTime() - right.reset.getTime());

  if (nextItems.length > 0) {
    lines.push("");
    lines.push(chalk.bold("下次预计："));
    const width = maxTextWidth(nextItems.map((item) => item.alias));
    for (const item of nextItems) {
      const isEnough = item.percentLeft !== null && item.percentLeft >= 90;
      const suffix = isEnough
        ? "额度还充足，低于 90% 后会自动刷新"
        : `${formatFriendlyTime(item.reset.toISOString())} 后会自动刷新`;
      const coloredSuffix = isEnough ? chalk.green(suffix) : chalk.cyan(suffix);
      lines.push(`  ${padText(item.alias, width)}  ${coloredSuffix}`);
    }
  }

  if (!launchAgentInstalled) {
    lines.push("");
    lines.push(chalk.red("自动刷新目前不会运行。请重新运行："));
    lines.push(`  ${chalk.cyan("bun cli quota --start")}`);
  } else if (failures.length === 0) {
    lines.push("");
    lines.push(chalk.green("无需操作。后台会继续自动检查。"));
  }

  return lines.join("\n");
}

function formatAutoQuotaFailure(alias: string, error: string | null): string {
  if (isTokenInvalidated(error)) {
    return `token 已失效，请运行 bun cli refresh ${alias}`;
  }
  return "暂时无法读取额度，后台会继续重试。";
}

function parseDate(value: string | null): Date | null {
  if (value === null || value.trim().length === 0) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
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
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDelta = Math.round((startOfDate - startOfToday) / 86_400_000);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (dayDelta === 0) return `今天 ${time}`;
  if (dayDelta === 1) return `明天 ${time}`;
  if (dayDelta === -1) return `昨天 ${time}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, "0");
}

function isTokenInvalidated(error: string | null): boolean {
  return Boolean(error?.includes("token_invalidated") || error?.includes("401 Unauthorized"));
}

function pickCallMessage(): string {
  return CALL_MESSAGES[Math.floor(Math.random() * CALL_MESSAGES.length)]!;
}

function formatCallFailure(alias: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isTokenInvalidated(message) || isAuthFailure(message)) {
    return `token 已失效。运行 cxa refresh ${alias} 后重试。`;
  }
  if (isQuotaFailure(message)) {
    return "没有可用额度，等待 quota reset 后重试。";
  }
  return firstMeaningfulLine(message);
}

function isAuthFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("auth required") ||
    lower.includes("not logged in") ||
    lower.includes("login required") ||
    lower.includes("authentication") ||
    lower.includes("session expired");
}

function isQuotaFailure(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("usage limit reached") ||
    lower.includes("usage limit") ||
    lower.includes("workspace credit limit") ||
    lower.includes("credit limit") ||
    lower.includes("out of credits") ||
    lower.includes("reached your") ||
    lower.includes("rate limit") ||
    lower.includes("quota");
}

function firstMeaningfulLine(message: string): string {
  return message.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ??
    "未知错误";
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
      throw new Error(`无法确认登录账号是否为 ${expectedEmail}，已取消刷新 ${alias}。`);
    }
    if (account.email.toLowerCase() !== expectedEmail.toLowerCase()) {
      throw new Error(
        `登录账号是 ${account.email}，不是 ${expectedEmail}，已取消刷新 ${alias}。`,
      );
    }
    return;
  }

  if (account.email !== null) {
    const ok = await confirm(
      `本次登录账号是 ${account.email}，确认用它刷新 ${alias} 吗？`,
    );
    if (!ok) throw new Error("已取消刷新。");
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
