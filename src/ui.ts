import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  AUTO_QUOTA_MAX_INTERVAL_MINUTES,
  AUTO_QUOTA_MIN_INTERVAL_MINUTES,
  readAutoQuotaState,
} from "./auto-quota.ts";
import {
  getAccountUsagePriorityByAlias,
  getRecommendedNextAlias,
} from "./account-priority.ts";
import { activeCommand, quotaCommand } from "./commands.ts";
import { recoverAutoQuotaServiceIfNeeded } from "./service.ts";
import { AccountStore } from "./store.ts";
import type { AutoQuotaState, CommandContext } from "./types.ts";
import type { UiStatus } from "./ui-status.ts";

const UI_APP_PORT = 41_739;
const PORTLESS_PROXY_PORT = 1_355;
const PORTLESS_NAME = "codexaccount";
const UI_EVENT_INTERVAL_MS = 5_000;
const UI_EVENT_HEARTBEAT_DATA = "ok";
const UI_LOCK_WAIT_MS = 30_000;
const AUTO_QUOTA_ACCOUNT_MIN_DELAY_MS = 5 * 60_000;
const AUTO_QUOTA_ACCOUNT_MAX_DELAY_MS = 6 * 60_000;

export async function uiCommand(
  context: CommandContext,
  options: { serve?: boolean } = {},
): Promise<void> {
  if (options.serve !== true) {
    await runPortlessUi(context);
    return;
  }

  const app = new Hono();
  const cssPath = path.join(import.meta.dir, "web", "static", "alignui.css");
  const webDistPath = path.join(import.meta.dir, "web", "dist");
  const indexPath = path.join(webDistPath, "index.html");

  app.get("/", async (c) => c.html(await readIndexHtml(indexPath)));
  app.get("/api/status", async (c) => c.json(await readStatus(context)));
  app.post("/api/accounts/active", async (c) => {
    try {
      const body = (await c.req.json()) as { alias?: unknown };
      if (typeof body.alias !== "string" || body.alias.trim().length === 0) {
        return c.text("请选择账号。", 400);
      }
      try {
        await activeCommand(context, body.alias, { lockWaitMs: UI_LOCK_WAIT_MS });
      } catch (error) {
        if (isLockBusyError(error)) {
          return c.text("后台正在刷新额度，请稍后再试。", 409);
        }
        throw error;
      }
      return c.json(await readStatus(context));
    } catch (error) {
      return c.text(error instanceof Error ? error.message : String(error), 500);
    }
  });
  app.post("/api/quota/retry", async (c) => {
    try {
      await quotaCommand(context);
      return c.json(await readStatus(context));
    } catch (error) {
      return c.text(error instanceof Error ? error.message : String(error), 500);
    }
  });
  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      let lastSignature = "";
      while (!stream.aborted) {
        const status = await readStatus(context);
        const signature = JSON.stringify(status);
        if (signature !== lastSignature) {
          lastSignature = signature;
          await stream.writeSSE({
            event: "status",
            data: signature,
          });
        } else {
          await stream.writeSSE({
            event: "heartbeat",
            data: UI_EVENT_HEARTBEAT_DATA,
          });
        }
        await stream.sleep(UI_EVENT_INTERVAL_MS);
      }
    }),
  );
  app.get("/assets/alignui.css", async (c) => {
    const css = await readFile(cssPath, "utf8");
    return c.body(css, 200, { "content-type": "text/css; charset=utf-8" });
  });
  app.get("/assets/*", async (c) => {
    const assetRoot = path.join(webDistPath, "assets");
    const assetName = c.req.path.slice("/assets/".length);
    const assetPath = path.join(assetRoot, assetName);
    const relativeAssetPath = path.relative(assetRoot, assetPath);
    if (
      relativeAssetPath.startsWith("..") ||
      path.isAbsolute(relativeAssetPath)
    ) {
      return c.text("Not found", 404);
    }
    try {
      const asset = await readFile(assetPath);
      return c.body(asset, 200, { "content-type": contentType(assetPath) });
    } catch {
      return c.text("Not found", 404);
    }
  });
  app.get("*", async (c) => c.html(await readIndexHtml(indexPath)));

  Bun.serve({
    hostname: "127.0.0.1",
    port: UI_APP_PORT,
    fetch: app.fetch,
  });

  context.stdout.write(
    `Web UI 内部服务已启动：http://127.0.0.1:${UI_APP_PORT}\n`,
  );
  await new Promise(() => undefined);
}

function isLockBusyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("另一个 bun cli 操作正在运行")
  );
}

async function runPortlessUi(context: CommandContext): Promise<void> {
  const portlessBin = path.resolve(
    import.meta.dir,
    "..",
    "node_modules",
    ".bin",
    "portless",
  );
  const publicUrl = `http://${PORTLESS_NAME}.localhost:${PORTLESS_PROXY_PORT}`;
  const child = spawn(
    portlessBin,
    [
      PORTLESS_NAME,
      "--app-port",
      String(UI_APP_PORT),
      "--",
      process.execPath,
      "--hot",
      path.resolve(process.argv[1] ?? "src/main.ts"),
      "ui",
      "--serve",
    ],
    {
      cwd: context.cwd,
      env: {
        ...process.env,
        CXA_HOME: context.appHome,
        CODEX_HOME: context.codexHome,
        CXA_CODEX_BIN: context.codexBin,
        PORTLESS_HTTPS: "0",
        PORTLESS_PORT: String(PORTLESS_PROXY_PORT),
      },
      stdio: "inherit",
    },
  );

  context.stdout.write(`Web UI 已启动：${publicUrl}\n`);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM") {
        resolve();
        return;
      }
      reject(new Error(`portless 已退出：${signal ?? code}`));
    });
  });
}

async function readStatus(context: CommandContext): Promise<UiStatus> {
  const store = new AccountStore(context.appHome);
  let [accounts, autoState] = await Promise.all([
    store.listSummaries(),
    readAutoQuotaState(context.appHome),
  ]);
  const serviceStatus = await recoverAutoQuotaServiceIfNeeded(
    context,
    autoState,
  );
  if (serviceStatus.recovered) {
    [accounts, autoState] = await Promise.all([
      store.listSummaries(),
      readAutoQuotaState(context.appHome),
    ]);
  }
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
  const priorityByAlias = getAccountUsagePriorityByAlias(accounts);
  const recommendedNextAlias = getRecommendedNextAlias(accounts);

  return {
    accounts: accounts.map((account) => ({
      alias: account.alias,
      email: account.meta?.email ?? null,
      planType: account.meta?.planType ?? null,
      subscriptionExpiresAt: account.meta?.subscriptionExpiresAt ?? null,
      isActive: account.isActive,
      hasAuth: account.hasAuth,
      quota: account.quota,
      usagePriority: priorityByAlias.get(account.alias) ?? {
        rank: null,
        status: "unknown",
        label: "unknown",
        reason: "quota unknown",
        nextRefillAt: null,
        availableAt: null,
        primaryWindow: "unknown",
        secondaryWindow: "unknown",
      },
      isRecommendedNext: account.alias === recommendedNextAlias,
      nextRefreshAt: schedule.get(account.alias)?.toISOString() ?? null,
      lastQuotaFetchAt: autoState.lastQuotaFetchAliases.includes(account.alias)
        ? autoState.lastQuotaFetchAt
        : null,
      lastCallAt: autoState.lastSuccessAliases.includes(account.alias)
        ? autoState.lastCallAt
        : null,
      lastCallStatus: autoState.lastSuccessAliases.includes(account.alias)
        ? "success"
        : "waiting",
    })),
    quota: {
      enabled: autoState.enabled,
      serviceRunning: serviceStatus.serviceRunning,
      serviceRecovered: serviceStatus.recovered,
      healthStatus: resolveHealthStatus(
        autoState,
        serviceStatus.serviceRunning,
      ),
      healthMessage: resolveHealthMessage(
        autoState,
        serviceStatus.serviceRunning,
      ),
      checkIntervalText: `${AUTO_QUOTA_MIN_INTERVAL_MINUTES}-${AUTO_QUOTA_MAX_INTERVAL_MINUTES} 分钟`,
      lastTickAt: autoState.lastTickAt,
      nextCheckAt: resolveNextCheckAt(autoState),
      lastWakeAt: autoState.lastWakeAt,
      lastMissedCheckCount: autoState.lastMissedCheckCount,
      lastQuotaFetchAt: autoState.lastQuotaFetchAt,
      lastCallAt: autoState.lastCallAt,
      lastSuccessAliases: autoState.lastSuccessAliases,
      lastFailureByAlias: autoState.lastFailureByAlias,
      lastQuotaFetchAliases: autoState.lastQuotaFetchAliases,
    },
  };
}

function resolveHealthStatus(
  state: AutoQuotaState,
  serviceRunning: boolean,
): UiStatus["quota"]["healthStatus"] {
  if (!state.enabled) return "paused";
  if (!serviceRunning) return "offline";
  if (isNextCheckOverdue(state, new Date())) return "delayed";
  return "healthy";
}

function resolveHealthMessage(
  state: AutoQuotaState,
  serviceRunning: boolean,
): string {
  const missed = resolveCurrentMissedCheckCount(state, new Date());
  if (!state.enabled) return "自动刷新已停止。";
  if (!serviceRunning) return "后台服务未运行，定时检查不会执行。";
  if (missed > 0) return `后台检查已延迟，可能错过 ${missed} 个检查周期。`;
  if (isNextCheckOverdue(state, new Date()))
    return "计划检查时间已过，后台服务异常。";
  return "后台服务在线，定时检查正常。";
}

function isNextCheckOverdue(state: AutoQuotaState, now: Date): boolean {
  if (!state.enabled || state.nextCheckAt === null) return false;
  const nextCheckAt = new Date(state.nextCheckAt);
  if (Number.isNaN(nextCheckAt.getTime())) return false;
  return nextCheckAt.getTime() <= now.getTime();
}

function resolveCurrentMissedCheckCount(
  state: AutoQuotaState,
  now: Date,
): number {
  if (!state.enabled || state.nextCheckAt === null) return 0;
  const nextCheckAt = new Date(state.nextCheckAt);
  if (Number.isNaN(nextCheckAt.getTime())) return 0;
  const lateMs = now.getTime() - nextCheckAt.getTime();
  if (lateMs < AUTO_QUOTA_MIN_INTERVAL_MINUTES * 60_000) return 0;
  return Math.max(
    1,
    Math.floor(lateMs / (AUTO_QUOTA_MIN_INTERVAL_MINUTES * 60_000)),
  );
}

async function readIndexHtml(indexPath: string): Promise<string> {
  try {
    return await readFile(indexPath, "utf8");
  } catch {
    return [
      "<!doctype html>",
      '<html lang="zh-CN">',
      "<head>",
      '<meta charset="utf-8" />',
      '<meta name="viewport" content="width=device-width, initial-scale=1" />',
      "<title>Codex Account</title>",
      "</head>",
      "<body>",
      "<p>Web UI 还没有构建。请先运行 bun run build:ui。</p>",
      "</body>",
      "</html>",
    ].join("");
  }
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath);
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "application/octet-stream";
}

function resolveNextCheckAt(state: AutoQuotaState): string | null {
  if (state.nextCheckAt !== null) {
    const nextCheckAt = new Date(state.nextCheckAt);
    if (Number.isNaN(nextCheckAt.getTime())) return null;
    if (nextCheckAt.getTime() <= Date.now()) return "后台服务异常";
    return state.nextCheckAt;
  }
  if (!state.enabled || state.lastTickAt === null) return null;
  const lastTickAt = new Date(state.lastTickAt);
  if (Number.isNaN(lastTickAt.getTime())) return null;
  const min = new Date(
    lastTickAt.getTime() + AUTO_QUOTA_MIN_INTERVAL_MINUTES * 60_000,
  );
  const max = new Date(
    lastTickAt.getTime() + AUTO_QUOTA_MAX_INTERVAL_MINUTES * 60_000,
  );
  return `${formatDateTime(min.toISOString())} - ${formatDateTime(max.toISOString())}`;
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

function formatDateTime(value: string | null): string {
  if (value === null) return "";
  if (value.includes(" - ")) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
