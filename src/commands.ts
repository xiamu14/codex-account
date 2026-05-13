import path from "node:path";
import { mkdir, mkdtemp } from "node:fs/promises";
import dayjs from "dayjs";
import { readAcpAccount, readAcpSnapshotBestEffort } from "./acp.ts";
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
          context.stdout.write(`已刷新 ${alias}\n`);
        } else {
          if (state.activeAccount === alias && isTokenInvalidated(snapshot.quotaError)) {
            await store.setActive(null);
            deactivatedAliases.push(alias);
          }
          warnings.push(formatQuotaWarning(alias, snapshot.quotaError));
          context.stdout.write(`已刷新 ${alias}，额度读取失败，已保留旧额度。\n`);
        }
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
