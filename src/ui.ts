import { readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import {
  AUTO_QUOTA_MAX_INTERVAL_MINUTES,
  AUTO_QUOTA_MIN_INTERVAL_MINUTES,
  readAutoQuotaState,
} from "./auto-quota.ts";
import { isAutoQuotaServiceRunning } from "./service.ts";
import { AccountStore } from "./store.ts";
import type { AccountQuota, AccountSummary, AutoQuotaState, CommandContext } from "./types.ts";

type UiStatus = {
  accounts: Array<{
    alias: string;
    email: string | null;
    planType: string | null;
    subscriptionExpiresAt: string | null;
    isActive: boolean;
    hasAuth: boolean;
    quota: AccountQuota | null;
    nextRefreshAt: string | null;
  }>;
  quota: {
    enabled: boolean;
    serviceRunning: boolean;
    lastTickAt: string | null;
    nextCheckAt: string | null;
    lastCallAt: string | null;
    lastSuccessAliases: string[];
    lastFailureByAlias: Record<string, string>;
    lastQuotaFetchAliases: string[];
  };
};

const DEFAULT_UI_PORT = 3789;
const AUTO_QUOTA_ACCOUNT_MIN_DELAY_MS = 5 * 60_000;
const AUTO_QUOTA_ACCOUNT_MAX_DELAY_MS = 6 * 60_000;

export async function uiCommand(
  context: CommandContext,
  options: { port?: number } = {},
): Promise<void> {
  const port = options.port ?? DEFAULT_UI_PORT;
  const app = new Hono();
  const cssPath = path.join(import.meta.dir, "web", "static", "alignui.css");

  app.get("/", async (c) => c.html(renderPage(await readStatus(context))));
  app.get("/api/status", async (c) => c.json(await readStatus(context)));
  app.get("/assets/alignui.css", async (c) => {
    const css = await readFile(cssPath, "utf8");
    return c.body(css, 200, { "content-type": "text/css; charset=utf-8" });
  });

  Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: app.fetch,
  });

  context.stdout.write(`Web UI 已启动：http://127.0.0.1:${port}\n`);
  await new Promise(() => undefined);
}

async function readStatus(context: CommandContext): Promise<UiStatus> {
  const store = new AccountStore(context.appHome);
  const [accounts, autoState, serviceRunning] = await Promise.all([
    store.listSummaries(),
    readAutoQuotaState(context.appHome),
    isAutoQuotaServiceRunning(context.appHome),
  ]);
  const schedule = buildAutoQuotaSchedule(
    accounts
      .map((account) => ({
        alias: account.alias,
        reset: account.quota?.fiveHour?.resetsAt ?? null,
      }))
      .filter((item): item is { alias: string; reset: string } => item.reset !== null),
  );

  return {
    accounts: accounts.map((account) => ({
      alias: account.alias,
      email: account.meta?.email ?? null,
      planType: account.meta?.planType ?? null,
      subscriptionExpiresAt: account.meta?.subscriptionExpiresAt ?? null,
      isActive: account.isActive,
      hasAuth: account.hasAuth,
      quota: account.quota,
      nextRefreshAt: schedule.get(account.alias)?.toISOString() ?? null,
    })),
    quota: {
      enabled: autoState.enabled,
      serviceRunning,
      lastTickAt: autoState.lastTickAt,
      nextCheckAt: resolveNextCheckAt(autoState),
      lastCallAt: autoState.lastCallAt,
      lastSuccessAliases: autoState.lastSuccessAliases,
      lastFailureByAlias: autoState.lastFailureByAlias,
      lastQuotaFetchAliases: autoState.lastQuotaFetchAliases,
    },
  };
}

function renderPage(status: UiStatus): string {
  const failures = Object.entries(status.quota.lastFailureByAlias);
  const nextRefresh = status.accounts
    .map((account) => account.nextRefreshAt)
    .filter((value): value is string => value !== null)
    .sort()[0] ?? null;

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>cxa quota</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <meta http-equiv="refresh" content="30" />
    <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400;14..32,500;14..32,600&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/assets/alignui.css" />
  </head>
  <body class="min-h-screen bg-bg-weak-50 font-sans text-text-strong-950 antialiased">
    <main class="mx-auto grid min-h-screen w-full max-w-[1440px] grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_360px_420px] lg:p-6">
      <section class="grid content-start gap-4">
        ${renderAccountsCard(status.accounts)}
      </section>
      <section class="grid content-start gap-4">
        ${renderQuotaStatusCard(status.quota, failures)}
      </section>
      <section class="grid content-start gap-4">
        ${renderScheduleCard(status.accounts, nextRefresh)}
        ${renderFailuresCard(failures)}
      </section>
    </main>
  </body>
</html>`;
}

function renderQuotaStatusCard(
  quota: UiStatus["quota"],
  failures: Array<[string, string]>,
): string {
  return card(`
    <div class="flex items-start justify-between gap-4">
      <div>
        <div class="text-label-lg text-text-strong-950">quota status</div>
        <div class="mt-1 text-paragraph-sm text-text-sub-600">${quota.enabled ? "自动刷新已开启" : "自动刷新未开启"}</div>
      </div>
      ${badge(quota.serviceRunning ? "service online" : "service off", quota.serviceRunning ? "green" : "red")}
    </div>
    ${divider()}
    <div class="grid gap-3">
      ${statusRow("上次检查", formatDateTime(quota.lastTickAt))}
      ${statusRow("下次检查", formatDateTime(quota.nextCheckAt))}
      ${statusRow("上次刷新", formatDateTime(quota.lastCallAt))}
      ${statusRow("失败账号", `${failures.length}`)}
    </div>
  `);
}

function renderAccountsCard(accounts: UiStatus["accounts"]): string {
  const rows = accounts.length === 0
    ? `<div class="rounded-20 border border-dashed border-stroke-soft-200 p-8 text-center text-paragraph-sm text-text-sub-600">还没有保存账号</div>`
    : accounts.map(renderAccountRow).join("");
  return card(`
    <div class="flex items-center justify-between gap-4">
      <div>
        <div class="text-label-xl text-text-strong-950">账号 list</div>
        <div class="mt-1 text-paragraph-sm text-text-sub-600">本地账号、token 和额度缓存</div>
      </div>
      ${badge(`${accounts.length} accounts`, "blue")}
    </div>
    ${divider()}
    <div class="grid gap-3">${rows}</div>
  `, "min-h-[560px]");
}

function renderAccountRow(account: UiStatus["accounts"][number]): string {
  const fiveHour = account.quota?.fiveHour?.percentLeft ?? null;
  const weekly = account.quota?.weekly?.percentLeft ?? null;
  return `
    <article class="rounded-20 border border-stroke-soft-200 bg-bg-white-0 p-4 shadow-regular-xs">
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <div class="truncate text-label-md text-text-strong-950">${escapeHtml(account.alias)}</div>
            ${account.isActive ? badge("active", "green") : ""}
          </div>
          <div class="mt-1 truncate text-paragraph-sm text-text-sub-600">${escapeHtml(account.email ?? "unknown email")}</div>
        </div>
        ${badge(account.hasAuth ? "token" : "no token", account.hasAuth ? "blue" : "red")}
      </div>
      <div class="mt-4 grid gap-3 md:grid-cols-2">
        ${quotaBlock("5h limit", fiveHour, account.quota?.fiveHour?.resetsAt ?? null)}
        ${quotaBlock("weekly", weekly, account.quota?.weekly?.resetsAt ?? null)}
      </div>
      <div class="mt-4 grid gap-2 text-paragraph-xs text-text-sub-600 sm:grid-cols-3">
        <span>plan: ${escapeHtml(account.planType ?? "unknown")}</span>
        <span>subscription: ${formatDate(account.subscriptionExpiresAt)}</span>
        <span>updated: ${formatDateTime(account.quota?.updatedAt ?? null)}</span>
      </div>
    </article>`;
}

function renderScheduleCard(accounts: UiStatus["accounts"], nextRefresh: string | null): string {
  const sorted = [...accounts]
    .filter((account) => account.nextRefreshAt !== null)
    .sort((left, right) => String(left.nextRefreshAt).localeCompare(String(right.nextRefreshAt)));
  const rows = sorted.length === 0
    ? `<div class="text-paragraph-sm text-text-sub-600">没有可计算的下次刷新时间</div>`
    : sorted.map((account) => statusRow(account.alias, formatDateTime(account.nextRefreshAt))).join("");
  return card(`
    <div class="flex items-start justify-between gap-4">
      <div>
        <div class="text-label-lg text-text-strong-950">下次刷新</div>
        <div class="mt-1 text-paragraph-sm text-text-sub-600">${formatDateTime(nextRefresh)}</div>
      </div>
      ${badge("schedule", "purple")}
    </div>
    ${divider()}
    <div class="grid gap-3">${rows}</div>
  `);
}

function renderFailuresCard(failures: Array<[string, string]>): string {
  const rows = failures.length === 0
    ? `<div class="text-paragraph-sm text-text-sub-600">暂无失败账号</div>`
    : failures.map(([alias, reason]) => `
      <div class="rounded-20 bg-error-lighter p-3">
        <div class="text-label-sm text-error-base">${escapeHtml(alias)}</div>
        <div class="mt-1 text-paragraph-xs text-text-sub-600">${escapeHtml(reason)}</div>
      </div>
    `).join("");
  return card(`
    <div class="flex items-center justify-between gap-4">
      <div class="text-label-lg text-text-strong-950">失败记录</div>
      ${badge(`${failures.length}`, failures.length === 0 ? "gray" : "red")}
    </div>
    ${divider()}
    <div class="grid gap-3">${rows}</div>
  `);
}

function resolveNextCheckAt(state: AutoQuotaState): string | null {
  if (state.nextCheckAt !== null) return state.nextCheckAt;
  if (!state.enabled || state.lastTickAt === null) return null;
  const lastTickAt = new Date(state.lastTickAt);
  if (Number.isNaN(lastTickAt.getTime())) return null;
  const min = new Date(lastTickAt.getTime() + AUTO_QUOTA_MIN_INTERVAL_MINUTES * 60_000);
  const max = new Date(lastTickAt.getTime() + AUTO_QUOTA_MAX_INTERVAL_MINUTES * 60_000);
  return `${formatDateTime(min.toISOString())} - ${formatDateTime(max.toISOString())}`;
}

function card(content: string, className = ""): string {
  return `<div class="rounded-20 border border-stroke-soft-200 bg-bg-white-0 p-6 shadow-regular-md ${className}">${content}</div>`;
}

function statusRow(label: string, value: string): string {
  return `<div class="flex items-center justify-between gap-4">
    <span class="text-paragraph-sm text-text-sub-600">${escapeHtml(label)}</span>
    <span class="text-right text-label-sm text-text-strong-950">${escapeHtml(value)}</span>
  </div>`;
}

function quotaBlock(label: string, percent: number | null, resetAt: string | null): string {
  const value = percent ?? 0;
  const tone = quotaTone(percent);
  return `<div>
    <div class="mb-2 flex items-center justify-between gap-3">
      <span class="text-label-sm text-text-strong-950">${escapeHtml(label)}</span>
      <span class="text-label-sm ${tone.textClass}">${percent === null ? "unknown" : `${percent}%`}</span>
    </div>
    <div class="h-2 rounded-full bg-bg-weak-50">
      <div class="h-2 rounded-full ${tone.barClass}" style="width:${Math.max(0, Math.min(100, value))}%"></div>
    </div>
    <div class="mt-2 text-paragraph-xs text-text-sub-600">reset: ${formatDateTime(resetAt)}</div>
  </div>`;
}

function quotaTone(percent: number | null): { barClass: string; textClass: string } {
  if (percent === null) {
    return { barClass: "bg-faded-base", textClass: "text-text-sub-600" };
  }
  if (percent >= 70) {
    return { barClass: "bg-success-base", textClass: "text-success-base" };
  }
  if (percent >= 40) {
    return { barClass: "bg-information-base", textClass: "text-information-base" };
  }
  if (percent >= 20) {
    return { barClass: "bg-warning-base", textClass: "text-warning-base" };
  }
  return { barClass: "bg-error-base", textClass: "text-error-base" };
}

function badge(label: string, color: "blue" | "gray" | "green" | "purple" | "red"): string {
  const colorClass = {
    blue: "bg-information-lighter text-information-base",
    gray: "bg-faded-lighter text-faded-base",
    green: "bg-success-lighter text-success-base",
    purple: "bg-feature-lighter text-feature-base",
    red: "bg-error-lighter text-error-base",
  }[color];
  return `<span class="inline-flex h-5 items-center justify-center rounded-full px-2 text-label-xs ${colorClass}">${escapeHtml(label)}</span>`;
}

function divider(): string {
  return `<div class="my-5 h-px w-full border-t border-dashed border-stroke-soft-200"></div>`;
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
  return min + stableHash(value) % (max - min + 1);
}

function formatDateTime(value: string | null): string {
  if (value === null) return "暂无";
  if (value.includes(" - ")) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(value: string | null): string {
  if (value === null) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
