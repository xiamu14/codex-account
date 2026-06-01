import http from "node:http";
import { log as clackLog } from "@clack/prompts";
import { readJsonIfExists, writeJsonAtomic } from "./fs.ts";
import { accountRefreshAutoStatePath, refreshAutoConfigPath } from "./paths.ts";

const DEFAULT_ROXY_API_BASE_URL = "http://127.0.0.1:50000";
const DEFAULT_CLASH_API_SOCKETS = ["/tmp/verge/verge-mihomo.sock"];
const DEFAULT_CLASH_API_BASE_URLS = [
  "http://127.0.0.1:9090",
  "http://127.0.0.1:9097",
];
const DEFAULT_TIMEOUT_MS = 15_000;
const AUTH_COMPLETION_TIMEOUT_MS = 5 * 60_000;
const LOGIN_PAGE_TIMEOUT_MS = 60_000;
const LOGIN_WAIT_LOG_INTERVAL_MS = 5_000;
const HUMAN_PAGE_SETTLE_MIN_DELAY_MS = 900;
const HUMAN_PAGE_SETTLE_MAX_DELAY_MS = 2_200;
const HUMAN_POST_CLICK_MIN_DELAY_MS = 1_800;
const HUMAN_POST_CLICK_MAX_DELAY_MS = 4_200;
const HUMAN_SUCCESS_READ_MIN_DELAY_MS = 6_000;
const HUMAN_SUCCESS_READ_MAX_DELAY_MS = 12_000;

export type RefreshAutoAccount = {
  alias: string;
  email: string | null;
};

export type RefreshAutoOptions = {
  appHome: string;
  account: RefreshAutoAccount;
  authUrl: string;
  authReady: () => Promise<boolean>;
  stdout: NodeJS.WriteStream;
  dryRun?: boolean;
  preflightOnly?: boolean;
  skipProxyCheck?: boolean;
};

type RefreshAutoConfig = {
  version: 1;
  roxy: {
    apiBaseUrl: string;
    token: string;
    workspaceId: string | number | null;
  };
  proxyCheck: {
    clashApiSockets: string[];
    clashApiBaseUrls: string[];
    clashSecret: string | null;
    timeoutMs: number;
    global: AccountRefreshAutoConfig | null;
    accounts: Record<string, AccountRefreshAutoConfig>;
  };
};

type AccountRefreshAutoConfig = {
  country: string;
  roxyWindowName?: string;
};

type RoxyProfile = {
  dirId: string;
  windowName: string;
  raw: Record<string, unknown>;
};

type ProxyProbe = {
  source: string;
  mode: string | null;
  expectedMode: string;
  country: string | null;
  expectedCountry: string;
  raw: unknown;
};

export async function runRefreshAuto(options: RefreshAutoOptions): Promise<void> {
  const config = await readRefreshAutoConfig(options.appHome);
  const accountConfig = resolveAccountConfig(config, options.account.alias, options.account.email);
  const expectedWindowName = accountConfig.roxyWindowName ?? options.account.email ?? options.account.alias;

  const roxy = new RoxyClient(config.roxy.apiBaseUrl, config.roxy.token);
  const workspaceId = config.roxy.workspaceId ?? await roxy.resolveWorkspaceId();
  const listedProfile = await roxy.findProfile(workspaceId, expectedWindowName);
  const profile = await roxy.readProfileDetail(workspaceId, listedProfile);

  const modeProbe = options.skipProxyCheck === true
    ? null
    : await checkClashRuleMode(config.proxyCheck);
  if (modeProbe !== null) {
    if (modeProbe.mode !== modeProbe.expectedMode) {
      await writeRefreshAutoState(options.appHome, options.account.alias, {
        ok: false,
        dryRun: options.dryRun === true,
        actual: modeProbe,
        windowName: profile.windowName,
      });
      throw new Error(
        `Clash 代理模式必须是全局，当前为 ${modeProbe.mode ?? "unknown"}，已取消自动刷新。`,
      );
    }
    options.stdout.write(
      `已确认 Clash 代理模式：全局。\n`,
    );

    const probe = checkRoxyProfileCountry(profile, accountConfig, modeProbe);
    if (probe.country !== probe.expectedCountry) {
      await writeRefreshAutoState(options.appHome, options.account.alias, {
        ok: false,
        dryRun: options.dryRun === true,
        actual: probe,
        windowName: profile.windowName,
      });
      throw new Error(
        `账号 ${options.account.alias} 期望 Roxy 代理国家 ${probe.expectedCountry}，实际为 ${probe.country ?? "unknown"}，已取消自动刷新。`,
      );
    }
    options.stdout.write(
      `已确认 ${options.account.alias} Roxy 代理国家：${probe.country}。\n`,
    );

    if (options.dryRun === true || options.preflightOnly === true) {
      await writeRefreshAutoState(options.appHome, options.account.alias, {
        ok: true,
        dryRun: true,
        actual: probe,
        windowName: profile.windowName,
      });
      return;
    }
  } else if (options.preflightOnly === true || options.dryRun === true) {
    throw new Error("dryRun/preflight 不能跳过代理检查。");
  }

  const opened = await roxy.openProfile(workspaceId, profile.dirId);
  const cdp = new CdpConnection(opened.ws);
  await cdp.connect();
  try {
    const tab = await cdp.createPage();
    try {
      await cdp.enablePage(tab.sessionId);
      await automateOpenAiLogin(cdp, tab.sessionId, options.authUrl, options.account.email ?? options.account.alias, options.authReady, options.stdout);
    } finally {
      await cdp.closeTarget(tab.targetId).catch(() => undefined);
    }
  } finally {
    cdp.close();
  }
}

async function readRefreshAutoConfig(appHome: string): Promise<RefreshAutoConfig> {
  const configPath = refreshAutoConfigPath(appHome);
  const parsed = await readJsonIfExists(configPath);
  if (!isRecord(parsed)) {
    throw new Error(`缺少自动刷新配置：${configPath}`);
  }
  if (parsed.version !== 1) {
    throw new Error("refresh-auto.json 的 version 必须为 1。");
  }
  if (!isRecord(parsed.roxy)) {
    throw new Error("refresh-auto.json 缺少 roxy 配置。");
  }
  const token = stringValue(parsed.roxy.token)?.trim();
  if (!token) {
    throw new Error("refresh-auto.json 缺少 roxy.token。");
  }
  const apiBaseUrl = stringValue(parsed.roxy.apiBaseUrl)?.trim() || DEFAULT_ROXY_API_BASE_URL;
  const workspaceId =
    normalizeRoxyWorkspaceId(
      stringValue(parsed.roxy.workspaceId) ?? numberValue(parsed.roxy.workspaceId),
    );

  if (!isRecord(parsed.proxyCheck)) {
    throw new Error("refresh-auto.json 缺少 proxyCheck 配置。");
  }
  const clashApiBaseUrl =
    stringValue(parsed.proxyCheck.clashApiBaseUrl)?.trim() ??
    stringValue(parsed.proxyCheck.clashApi)?.trim();
  const clashApiBaseUrls = clashApiBaseUrl === undefined
    ? DEFAULT_CLASH_API_BASE_URLS
    : [clashApiBaseUrl];
  const clashApiSocket = stringValue(parsed.proxyCheck.clashApiSocket)?.trim();
  const clashApiSockets = clashApiSocket === undefined
    ? DEFAULT_CLASH_API_SOCKETS
    : [clashApiSocket];
  const clashSecret = stringValue(parsed.proxyCheck.clashSecret)?.trim() ?? null;
  const timeoutMs = numberValue(parsed.proxyCheck.timeoutMs) ?? DEFAULT_TIMEOUT_MS;
  const global = parseAccountConfig(parsed.proxyCheck.global, "proxyCheck.global");
  const accountsRaw = isRecord(parsed.proxyCheck.accounts) ? parsed.proxyCheck.accounts : {};
  const accounts: Record<string, AccountRefreshAutoConfig> = {};
  for (const [alias, value] of Object.entries(accountsRaw)) {
    accounts[alias] = requireAccountConfig(value, `proxyCheck.accounts.${alias}`);
  }

  return {
    version: 1,
    roxy: { apiBaseUrl, token, workspaceId },
    proxyCheck: { clashApiSockets, clashApiBaseUrls, clashSecret, timeoutMs, global, accounts },
  };
}

function resolveAccountConfig(
  config: RefreshAutoConfig,
  alias: string,
  email: string | null,
): AccountRefreshAutoConfig {
  const accountConfig = config.proxyCheck.accounts[alias] ?? (
    email === null ? undefined : config.proxyCheck.accounts[email]
  );
  const resolved = accountConfig ?? config.proxyCheck.global;
  if (resolved === null || resolved === undefined) {
    throw new Error(`账号 ${alias} 缺少自动刷新配置。`);
  }
  return resolved;
}

function parseAccountConfig(value: unknown, label: string): AccountRefreshAutoConfig | null {
  if (value === undefined || value === null) return null;
  return requireAccountConfig(value, label);
}

function requireAccountConfig(value: unknown, label: string): AccountRefreshAutoConfig {
  if (!isRecord(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  const country = normalizeCountryCode(stringValue(value.country));
  if (country === null) {
    throw new Error(`${label}.country 必须是 ISO 两位大写国家码。`);
  }
  const roxyWindowName = stringValue(value.roxyWindowName);
  return {
    country,
    ...(roxyWindowName === null ? {} : { roxyWindowName }),
  };
}

async function writeRefreshAutoState(
  appHome: string,
  alias: string,
  value: {
    ok: boolean;
    dryRun?: boolean;
    actual: ProxyProbe;
    windowName: string;
  },
): Promise<void> {
  await writeJsonAtomic(accountRefreshAutoStatePath(appHome, alias), {
    version: 1,
    updatedAt: new Date().toISOString(),
    ...value,
  });
}

class RoxyClient {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly token: string,
  ) {}

  async resolveWorkspaceId(): Promise<string | number> {
    const response = await this.request("/browser/workspace", {});
    const rows = rowsFromResponse(response);
    const id = rows
      .map((row) => isRecord(row)
        ? stringValue(row.workspaceId) ??
          stringValue(row.id) ??
          numberValue(row.workspaceId) ??
          numberValue(row.id)
        : null)
      .find((value): value is string | number => value !== null);
    if (id === undefined) {
      throw new Error("无法从 Roxy /browser/workspace 获取 workspaceId，请在 refresh-auto.json 里配置 roxy.workspaceId。");
    }
    return id;
  }

  async findProfile(workspaceId: string | number, windowName: string): Promise<RoxyProfile> {
    const response = await this.request("/browser/list_v3", {
      workspaceId,
      windowName,
      page_index: 1,
      page_size: 100,
    });
    const matches = rowsFromResponse(response)
      .filter(isRecord)
      .filter((row) => stringValue(row.windowName) === windowName);
    if (matches.length === 0) {
      throw new Error(`没有找到 Roxy 窗口：${windowName}。请确认窗口名称，或在 refresh-auto.json 里配置 roxyWindowName。`);
    }
    if (matches.length > 1) {
      throw new Error(`找到多个同名 Roxy 窗口：${windowName}。请保证窗口名唯一。`);
    }
    const row = matches[0]!;
    const dirId = stringValue(row.dirId);
    if (dirId === null) {
      throw new Error(`Roxy 窗口 ${windowName} 缺少 dirId。`);
    }
    return { dirId, windowName, raw: row };
  }

  async readProfileDetail(
    workspaceId: string | number,
    profile: RoxyProfile,
  ): Promise<RoxyProfile> {
    const response = await this.request("/browser/detail", {
      workspaceId,
      dirId: profile.dirId,
    });
    const row = rowsFromResponse(response).filter(isRecord)[0];
    if (row === undefined) return profile;
    return {
      ...profile,
      raw: {
        ...profile.raw,
        ...row,
      },
    };
  }

  async openProfile(workspaceId: string | number, dirId: string): Promise<{ ws: string }> {
    const response = await this.request("/browser/open", { workspaceId, dirId }, "POST");
    const ws = pickString(response, ["ws", "data.ws", "data.websocket", "data.wsUrl"]);
    if (ws === null) {
      throw new Error(`Roxy 打开窗口失败：${JSON.stringify(response)}`);
    }
    return { ws };
  }

  private async request(
    endpoint: string,
    params: Record<string, string | number>,
    method: "GET" | "POST" = "GET",
  ): Promise<unknown> {
    const url = new URL(endpoint, ensureTrailingSlash(this.apiBaseUrl));
    const headers = { token: this.token };
    const requestUrl = method === "GET" ? withQuery(url, params) : url;
    const response = await fetchText(
      requestUrl,
      method === "GET"
        ? { headers }
        : {
            method,
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify(params),
          },
      `Roxy API ${endpoint}`,
    );
    if (!response.ok) {
      throw new Error(`Roxy API ${endpoint} 失败：HTTP ${response.status} ${response.text}`);
    }
    const parsed = response.text.trim().length === 0 ? null : JSON.parse(response.text) as unknown;
    if (isRecord(parsed) && numberValue(parsed.code) !== null && numberValue(parsed.code) !== 0) {
      throw new Error(`Roxy API ${endpoint} 失败：${JSON.stringify(parsed)}`);
    }
    return parsed;
  }
}

async function checkClashRuleMode(
  config: RefreshAutoConfig["proxyCheck"],
): Promise<ProxyProbe> {
  const headers: Record<string, string> = {};
  if (config.clashSecret !== null) {
    headers.authorization = `Bearer ${config.clashSecret}`;
  }

  const failures: string[] = [];
  for (const socketPath of config.clashApiSockets) {
    try {
      const response = await fetchTextUnixSocket(
        socketPath,
        "/configs",
        { headers },
        "Clash API /configs",
      );
      if (!response.ok) {
        failures.push(`${socketPath} HTTP ${response.status} ${response.text}`);
        continue;
      }
      const parsed = JSON.parse(response.text) as unknown;
      if (!isRecord(parsed)) {
        failures.push(`${socketPath} 响应格式不正确`);
        continue;
      }
      const mode = normalizeClashMode(stringValue(parsed.mode));
      return {
        source: "clash-configs",
        mode,
        expectedMode: "global",
        country: null,
        expectedCountry: "",
        raw: { socketPath, ...parsed },
      };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const baseUrl of config.clashApiBaseUrls) {
    const url = new URL("/configs", ensureTrailingSlash(baseUrl));
    try {
      const response = await fetchText(url, { headers }, "Clash API /configs");
      if (!response.ok) {
        failures.push(`${url.toString()} HTTP ${response.status} ${response.text}`);
        continue;
      }
      const parsed = JSON.parse(response.text) as unknown;
      if (!isRecord(parsed)) {
        failures.push(`${url.toString()} 响应格式不正确`);
        continue;
      }
      const mode = normalizeClashMode(stringValue(parsed.mode));
      return {
        source: "clash-configs",
        mode,
        expectedMode: "global",
        country: null,
        expectedCountry: "",
        raw: { url: baseUrl, ...parsed },
      };
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    [
      "无法连接 Clash controller /configs。",
      "截图中的 127.0.0.1:7897 是系统代理端口，不是 controller 端口。",
      "ClashVerge Rev 默认可以使用 Unix socket：/tmp/verge/verge-mihomo.sock；也可以在设置里开启 External Controller / 外部控制端口，并在 refresh-auto.json 配置 proxyCheck.clashApiBaseUrl。",
      `已尝试：${failures.join("；")}`,
    ].join("\n"),
  );
}

async function fetchText(
  url: URL,
  init: RequestInit,
  label: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const response = await fetch(url, init);
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} 连接失败：${url.toString()}。${message}`);
  }
}

async function fetchTextUnixSocket(
  socketPath: string,
  path: string,
  init: { headers?: Record<string, string> },
  label: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  return await new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path,
        method: "GET",
        headers: init.headers,
      },
      (response) => {
        response.setEncoding("utf8");
        let text = "";
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({
            ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
            status: response.statusCode ?? 0,
            text,
          });
        });
      },
    );
    request.setTimeout(DEFAULT_TIMEOUT_MS, () => {
      request.destroy(new Error(`${label} 连接超时：${socketPath}`));
    });
    request.on("error", (error) => {
      reject(new Error(`${label} 连接失败：${socketPath}。${error.message}`));
    });
    request.end();
  });
}

function checkRoxyProfileCountry(
  profile: RoxyProfile,
  accountConfig: AccountRefreshAutoConfig,
  modeProbe: ProxyProbe,
): ProxyProbe {
  const candidates = [
    profile.raw,
    isRecord(profile.raw.proxyInfo) ? profile.raw.proxyInfo : null,
    isRecord(profile.raw.proxy) ? profile.raw.proxy : null,
  ].filter(isRecord);
  for (const value of candidates) {
    const country = normalizeCountryCode(firstString(value, [
      "country",
      "countryCode",
      "country_code",
      "ipCountry",
      "proxyCountry",
      "proxyCountryCode",
      "lastCountry",
      "regionCode",
    ]));
    if (country !== null) {
      return {
        ...modeProbe,
        source: "clash-configs+roxy-profile",
        country,
        expectedCountry: accountConfig.country,
        raw: { clash: modeProbe.raw, roxy: profile.raw },
      };
    }
  }
  return {
    ...modeProbe,
    source: "clash-configs+roxy-profile",
    country: null,
    expectedCountry: accountConfig.country,
    raw: { clash: modeProbe.raw, roxy: profile.raw },
  };
}

function normalizeClashMode(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "rule" || normalized === "rules") return "rule";
  if (normalized === "global") return "global";
  if (normalized === "direct") return "direct";
  return normalized;
}

function normalizeCountryCode(value: string | null): string | null {
  if (value === null) return null;
  const upper = value.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  if (upper === "UNITED STATES" || upper === "UNITED STATES OF AMERICA") return "US";
  if (upper === "SINGAPORE") return "SG";
  if (upper === "JAPAN") return "JP";
  if (upper === "HONG KONG") return "HK";
  return null;
}

async function automateOpenAiLogin(
  cdp: CdpConnection,
  sessionId: string,
  authUrl: string,
  email: string,
  authReady: () => Promise<boolean>,
  stdout: NodeJS.WriteStream,
): Promise<void> {
  const log = createRefreshAutoLogger(stdout);
  log(`自动登录：打开 Codex 授权链接。`);
  await cdp.navigate(sessionId, authUrl, LOGIN_PAGE_TIMEOUT_MS);
  await humanPageSettle(log);
  const completionDeadline = Date.now() + AUTH_COMPLETION_TIMEOUT_MS;

  log(`自动登录：等待 ChatGPT 登录入口，最多 60 秒。`);
  const firstStep = await waitForLoginAction(
    cdp,
    sessionId,
    email,
    authReady,
    completionDeadline,
    "等待 ChatGPT 登录入口超时：1 分钟内没有出现已登录账号或 Continue with Google。",
    log,
  );
  if (firstStep.kind === "authenticated") {
    log(`自动登录：已检测到登录完成。`);
    await humanSuccessRead(log);
    return;
  }
  logLoginClick(firstStep, log);
  await humanReadBeforeClick(firstStep.targetKind, log);
  await humanClick(cdp, sessionId, firstStep.target, log);
  log(`自动登录：已发送点击。`);
  await humanPostClickPause(log);

  if (firstStep.targetKind === "google-provider") {
    log(`自动登录：等待 Google/ChatGPT 下一步，最多 60 秒。`);
    const accountStep = await waitForLoginAction(
      cdp,
      sessionId,
      email,
      authReady,
      completionDeadline,
      "等待登录下一步超时：1 分钟内没有出现已登录账号或 Codex 授权页 Continue。",
      log,
      "post-google",
    );
    if (accountStep.kind === "authenticated") {
      log(`自动登录：已检测到登录完成。`);
      await humanSuccessRead(log);
      return;
    }
    logLoginClick(accountStep, log);
    await humanReadBeforeClick(accountStep.targetKind, log);
    await humanClick(cdp, sessionId, accountStep.target, log);
    log(`自动登录：已发送点击。`);
    await humanPostClickPause(log);

    if (accountStep.targetKind === "codex-consent") {
      log(`自动登录：等待 Codex 成功页或 auth.json，最多 60 秒。`);
      const successStep = await waitForLoginAction(
        cdp,
        sessionId,
        email,
        authReady,
        completionDeadline,
        "等待 Codex 登录完成超时：1 分钟内没有出现 Signed in to Codex。",
        log,
        "success",
      );
      if (successStep.kind === "authenticated") {
        log(`自动登录：Codex 登录完成。`);
        await humanSuccessRead(log);
        return;
      }
      throw new Error("自动登录失败：没有生成 auth.json。");
    }
  }

  log(`自动登录：等待 Codex 授权页 Continue，最多 60 秒。`);
  const consentStep = await waitForLoginAction(
    cdp,
    sessionId,
    email,
    authReady,
    completionDeadline,
    "等待 Codex 授权页超时：1 分钟内没有出现 Continue。",
    log,
    "codex-consent",
  );
  if (consentStep.kind === "authenticated") {
    log(`自动登录：已检测到登录完成。`);
    await humanSuccessRead(log);
    return;
  }
  logLoginClick(consentStep, log);
  await humanReadBeforeClick(consentStep.targetKind, log);
  await humanClick(cdp, sessionId, consentStep.target, log);
  log(`自动登录：已发送点击。`);
  await humanPostClickPause(log);

  log(`自动登录：等待 Codex 成功页或 auth.json，最多 60 秒。`);
  const successStep = await waitForLoginAction(
    cdp,
    sessionId,
    email,
    authReady,
    completionDeadline,
    "等待 Codex 登录完成超时：1 分钟内没有出现 Signed in to Codex。",
    log,
    "success",
  );
  if (successStep.kind === "authenticated") {
    log(`自动登录：Codex 登录完成。`);
    await humanSuccessRead(log);
    return;
  }
  throw new Error("自动登录失败：没有生成 auth.json。");
}

type LoginPageState = {
  url: string;
  text: string;
};

type ClickTarget = {
  x: number;
  y: number;
};

type LoginAction = {
  kind: "click";
  target: ClickTarget & { label: string };
  targetKind: LoginClickTargetKind;
} | {
  kind: "authenticated";
};

type LoginActionMode = "initial" | "post-google" | "codex-consent" | "success";
type LoginClickTargetKind = "account" | "google-provider" | "codex-consent";

async function waitForLoginAction(
  cdp: CdpConnection,
  sessionId: string,
  email: string,
  authReady: () => Promise<boolean>,
  completionDeadline: number,
  timeoutMessage: string,
  log: RefreshAutoLog,
  mode: LoginActionMode = "initial",
): Promise<LoginAction> {
  const deadline = Math.min(Date.now() + LOGIN_PAGE_TIMEOUT_MS, completionDeadline);
  let lastWaitLogAt = 0;
  while (Date.now() < deadline) {
    if (await authReady()) {
      log(`自动登录：检测到 auth.json 已生成。`);
      return { kind: "authenticated" };
    }
    const state = await readLoginPageState(cdp, sessionId);
    if (isCodexLoginSuccess(state.text)) {
      log(`自动登录：检测到 Signed in to Codex 成功页。`);
      return { kind: "authenticated" };
    }
    throwIfManualInterventionRequired(state, email);

    const target = await findLoginClickTarget(cdp, sessionId, email, mode);
    if (target !== null) {
      log(`自动登录：找到可点击目标 ${formatClickTarget(target.kind, target.label)}。`);
      return { kind: "click", target, targetKind: target.kind };
    }
    const now = Date.now();
    if (now - lastWaitLogAt >= LOGIN_WAIT_LOG_INTERVAL_MS) {
      lastWaitLogAt = now;
      log(`自动登录：等待中，阶段 ${mode}，页面 ${summarizeLoginPage(state)}。`);
    }
    await delay(1_000);
  }
  throw new Error(timeoutMessage);
}

async function readLoginPageState(
  cdp: CdpConnection,
  sessionId: string,
): Promise<LoginPageState> {
  return await cdp.evaluateJson<LoginPageState>(
    sessionId,
    `(() => ({
      url: location.href,
      text: document.body?.innerText || "",
    }))()`,
    5_000,
  );
}

async function findLoginClickTarget(
  cdp: CdpConnection,
  sessionId: string,
  email: string,
  mode: LoginActionMode,
): Promise<(ClickTarget & { kind: LoginClickTargetKind; label: string }) | null> {
  return await cdp.evaluateJson<(ClickTarget & { kind: LoginClickTargetKind; label: string }) | null>(
    sessionId,
    `((email, mode) => {
      const text = document.body?.innerText || "";
      const normalizedEmail = String(email).toLowerCase().replace(/\\s+/g, "");
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const point = (element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return {
          x: rect.left + rect.width * (0.35 + Math.random() * 0.3),
          y: rect.top + rect.height * (0.35 + Math.random() * 0.3),
        };
      };
      const label = (element) => [
        element.getAttribute("data-identifier"),
        element.getAttribute("aria-label"),
        element.innerText,
        element.textContent,
        element.getAttribute("value"),
      ].find((value) => typeof value === "string" && value.trim().length > 0)?.trim() || "";
      const normalizedLabel = (element) => label(element).toLowerCase().replace(/\\s+/g, "");
      const controls = [...document.querySelectorAll("button, input[type='button'], input[type='submit'], a, div[role='button'], div[role='link'], li[role='option'], [data-identifier]")]
        .filter((element) => visible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true");
      const exactText = (element, value) => label(element).trim().toLowerCase().replace(/\\s+/g, " ") === value;

      if (mode === "success") return null;

      if (mode === "codex-consent" || (mode === "post-google" && /sign in to codex with chatgpt/i.test(text))) {
        if (mode === "codex-consent" && !/sign in to codex with chatgpt/i.test(text)) return null;
        const target = controls.find((element) => exactText(element, "continue"));
        const clickPoint = target ? point(target) : null;
        return clickPoint && target ? { ...clickPoint, kind: "codex-consent", label: label(target) } : null;
      }

      if (location.hostname.endsWith("google.com")) {
        const googleAccount = controls.find((element) => {
          const value = normalizedLabel(element);
          return value.includes(normalizedEmail);
        });
        const clickPoint = googleAccount ? point(googleAccount) : null;
        return clickPoint && googleAccount ? { ...clickPoint, kind: "account", label: label(googleAccount) } : null;
      }

      const chatgptAccount = controls.find((element) => {
        const value = normalizedLabel(element);
        if (normalizedEmail.length > 0 && value.includes(normalizedEmail)) return true;
        return /choose an account to continue/i.test(text) &&
          /@/.test(label(element)) &&
          !/log in to another account|create account/i.test(label(element));
      });
      if (chatgptAccount) {
        const clickPoint = point(chatgptAccount);
        return clickPoint ? { ...clickPoint, kind: "account", label: label(chatgptAccount) } : null;
      }

      const googleButton = controls.find((element) => /continue with google/i.test(label(element)));
      const clickPoint = googleButton ? point(googleButton) : null;
      return clickPoint && googleButton ? { ...clickPoint, kind: "google-provider", label: label(googleButton) } : null;
    })(${JSON.stringify(email)}, ${JSON.stringify(mode)})`,
    5_000,
  );
}

type RefreshAutoLog = (message: string) => void;

function createRefreshAutoLogger(stdout: NodeJS.WriteStream): RefreshAutoLog {
  void stdout;
  return (message: string) => {
    clackLog.info(`[${formatLogTime()}] ${message}`);
  };
}

function formatLogTime(): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function logLoginClick(
  action: Extract<LoginAction, { kind: "click" }>,
  log: RefreshAutoLog,
): void {
  log(
    `自动登录：准备点击 ${formatClickTarget(action.targetKind, action.target.label)}，坐标 (${Math.round(action.target.x)}, ${Math.round(action.target.y)})。`,
  );
}

function formatClickTarget(kind: LoginClickTargetKind, label: string): string {
  const name = kind === "google-provider"
    ? "Continue with Google"
    : kind === "codex-consent"
      ? "Codex Continue"
      : "账号";
  const trimmed = label.replace(/\s+/g, " ").trim();
  return trimmed.length === 0 ? name : `${name} [${trimmed}]`;
}

function summarizeLoginPage(state: LoginPageState): string {
  const title = detectLoginPageTitle(state.text);
  try {
    const url = new URL(state.url);
    return `${url.hostname}${url.pathname} / ${title}`;
  } catch {
    return title;
  }
}

function detectLoginPageTitle(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("sign in to codex with chatgpt")) return "Codex 授权页";
  if (lower.includes("choose an account to continue")) return "账号选择页";
  if (lower.includes("continue with google")) return "ChatGPT 登录页";
  if (lower.includes("signed in to codex")) return "Codex 成功页";
  if (lower.includes("your session has ended")) return "ChatGPT 错误页";
  if (lower.includes("enter your password")) return "Google 密码页";
  if (lower.includes("2-step verification") || lower.includes("two-step verification")) return "Google 2FA 页";
  return "未知页面";
}

function throwIfManualInterventionRequired(state: LoginPageState, email: string): void {
  const chatGptError = readChatGptAuthError(state.text);
  if (chatGptError !== null) {
    throw new Error(chatGptError);
  }
  if (requiresManualGoogleLogin(state.text)) {
    throw new Error(
      `自动刷新暂停：Google 账号 ${email} 未处于可自动选择状态。请先在对应 Roxy 窗口里手动登录 Google，然后重新运行 bun cli refresh --auto。`,
    );
  }
  if (isMissingChatGptSession(state)) {
    throw new Error(
      `自动刷新暂停：ChatGPT 没有已登录账号，也没有 Continue with Google 入口。请先在对应 Roxy 窗口里登录 ChatGPT，然后重新运行 bun cli refresh --auto。`,
    );
  }
}

function readChatGptAuthError(text: string): string | null {
  const lower = text.toLowerCase();
  if (!lower.includes("your session has ended") && !lower.includes("error_code:")) {
    return null;
  }
  const code = /error_code:\s*([a-z0-9_]+)/i.exec(text)?.[1] ?? "unknown";
  if (code === "sign_in_with_chatgpt_codex_consent_missing_workspaces") {
    return "自动刷新失败：ChatGPT 返回 missing_workspaces。已点击 Codex 授权页 Continue，但这个 ChatGPT 会话没有可用于 Codex 的 workspace。请先在该 Roxy 窗口里打开 ChatGPT，确认账号和 workspace 正常，再重新运行 bun cli refresh --auto。";
  }
  return `自动刷新失败：ChatGPT 登录页返回错误 ${code}。请先在对应 Roxy 窗口里手动确认账号状态，再重新运行 bun cli refresh --auto。`;
}

function requiresManualGoogleLogin(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("enter your password") ||
    lower.includes("输入您的密码") ||
    lower.includes("2-step verification") ||
    lower.includes("two-step verification") ||
    lower.includes("verify it") ||
    lower.includes("验证码") ||
    lower.includes("captcha") ||
    lower.includes("passkey") ||
    lower.includes("recovery email") ||
    lower.includes("恢复邮箱")
  );
}

function isMissingChatGptSession(state: LoginPageState): boolean {
  const lower = state.text.toLowerCase();
  return lower.includes("choose an account to continue") &&
    lower.includes("log in to another account") &&
    !lower.includes("continue with google") &&
    !/@/.test(state.text);
}

function isCodexLoginSuccess(text: string): boolean {
  const lower = text.toLowerCase();
  return lower.includes("signed in to codex") && lower.includes("you may now close this page");
}

async function humanClick(
  cdp: CdpConnection,
  sessionId: string,
  target: ClickTarget,
  log: RefreshAutoLog,
): Promise<void> {
  try {
    const start = {
      x: target.x + randomInt(-120, 120),
      y: target.y + randomInt(-80, 80),
    };
    const steps = randomInt(5, 9);
    for (let index = 1; index <= steps; index += 1) {
      const t = index / steps;
      const ease = t * t * (3 - 2 * t);
      await cdp.dispatchMouseEvent(sessionId, "mouseMoved", {
        x: start.x + (target.x - start.x) * ease + randomInt(-2, 2),
        y: start.y + (target.y - start.y) * ease + randomInt(-2, 2),
      });
      await delay(randomInt(25, 90));
    }
    await delay(randomInt(120, 450));
    await cdp.dispatchMouseEvent(sessionId, "mousePressed", target);
    await delay(randomInt(80, 180));
    await cdp.dispatchMouseEvent(sessionId, "mouseReleased", target);
  } catch {
    log(`自动登录：CDP 鼠标点击失败，改用页面内 click fallback。`);
    await cdp.clickElementAtPoint(sessionId, target, 10_000);
  }
}

async function humanPageSettle(log: RefreshAutoLog): Promise<void> {
  const ms = randomInt(HUMAN_PAGE_SETTLE_MIN_DELAY_MS, HUMAN_PAGE_SETTLE_MAX_DELAY_MS);
  log(`自动登录：页面打开后停留 ${formatDelaySeconds(ms)}，等待内容稳定。`);
  await delay(ms);
}

async function humanReadBeforeClick(
  kind: LoginClickTargetKind,
  log: RefreshAutoLog,
): Promise<void> {
  const [min, max] = kind === "codex-consent"
    ? [4_000, 8_500]
    : kind === "google-provider"
      ? [1_800, 4_200]
      : [1_200, 3_200];
  const ms = randomInt(min, max);
  log(`自动登录：点击前停留 ${formatDelaySeconds(ms)}，模拟阅读确认。`);
  await delay(ms);
}

async function humanPostClickPause(log: RefreshAutoLog): Promise<void> {
  const ms = randomInt(HUMAN_POST_CLICK_MIN_DELAY_MS, HUMAN_POST_CLICK_MAX_DELAY_MS);
  log(`自动登录：点击后观察 ${formatDelaySeconds(ms)}，等待页面响应。`);
  await delay(ms);
}

async function humanSuccessRead(log: RefreshAutoLog): Promise<void> {
  const ms = randomInt(HUMAN_SUCCESS_READ_MIN_DELAY_MS, HUMAN_SUCCESS_READ_MAX_DELAY_MS);
  log(`自动登录：成功后停留 ${formatDelaySeconds(ms)}，确认页面状态后再关闭 tab。`);
  await delay(ms);
}

function formatDelaySeconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} 秒`;
}

class CdpConnection {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: Timer;
  }>();

  constructor(private readonly wsUrl: string) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.wsUrl);
      this.socket = socket;
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("无法连接 Roxy 浏览器自动化 ws。")), { once: true });
      socket.addEventListener("message", (event) => this.handleMessage(event.data));
    });
  }

  close(): void {
    this.socket?.close();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP 连接已关闭。"));
    }
    this.pending.clear();
  }

  async createPage(): Promise<{ targetId: string; sessionId: string }> {
    const created = await this.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const attached = await this.send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: created.targetId,
      flatten: true,
    });
    return { targetId: created.targetId, sessionId: attached.sessionId };
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.send("Target.closeTarget", { targetId }, undefined, 5_000);
  }

  async enablePage(sessionId: string): Promise<void> {
    await this.send("Page.enable", {}, sessionId);
    await this.send("Runtime.enable", {}, sessionId);
  }

  async navigate(sessionId: string, url: string, timeoutMs: number): Promise<void> {
    await this.send("Page.navigate", { url }, sessionId, timeoutMs);
    await delay(500);
  }

  async dispatchMouseEvent(
    sessionId: string,
    type: "mouseMoved" | "mousePressed" | "mouseReleased",
    point: { x: number; y: number },
  ): Promise<void> {
    await this.send(
      "Input.dispatchMouseEvent",
      {
        type,
        x: Math.max(0, Math.round(point.x)),
        y: Math.max(0, Math.round(point.y)),
        button: type === "mouseMoved" ? "none" : "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: type === "mouseMoved" ? 0 : 1,
      },
      sessionId,
      10_000,
    );
  }

  async clickElementAtPoint(
    sessionId: string,
    point: { x: number; y: number },
    timeoutMs: number,
  ): Promise<void> {
    const clicked = await this.evaluateBoolean(
      sessionId,
      `((x, y) => {
        const leaf = document.elementFromPoint(x, y);
        if (!leaf) return false;
        const target = leaf.closest("button, a, [role='button'], [role='link'], [data-identifier], li") || leaf;
        target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        if (typeof target.click === "function") {
          target.click();
        } else {
          target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        }
        return true;
      })(${Math.round(point.x)}, ${Math.round(point.y)})`,
      timeoutMs,
    );
    if (!clicked) {
      throw new Error("无法通过页面坐标点击目标元素。");
    }
  }

  async evaluateString(sessionId: string, expression: string, timeoutMs: number): Promise<string> {
    const result = await this.evaluate(sessionId, expression, timeoutMs);
    if (typeof result !== "string") {
      throw new Error("页面返回的不是字符串。");
    }
    return result;
  }

  async evaluateBoolean(sessionId: string, expression: string, timeoutMs: number): Promise<boolean> {
    const result = await this.evaluate(sessionId, expression, timeoutMs);
    return result === true;
  }

  async evaluateJson<T>(sessionId: string, expression: string, timeoutMs: number): Promise<T> {
    return await this.evaluate(sessionId, expression, timeoutMs) as T;
  }

  private async evaluate(sessionId: string, expression: string, timeoutMs: number): Promise<unknown> {
    const response = await this.send<{
      result?: { value?: unknown };
      exceptionDetails?: unknown;
    }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
      timeoutMs,
    );
    if (response.exceptionDetails !== undefined) {
      throw new Error(`页面脚本执行失败：${JSON.stringify(response.exceptionDetails)}`);
    }
    return response.result?.value;
  }

  private async send<T>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) {
      throw new Error("CDP 连接未打开。");
    }
    const id = this.nextId++;
    const message = sessionId === undefined
      ? { id, method, params }
      : { id, method, params, sessionId };
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时。`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      socket.send(JSON.stringify(message));
    });
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;
    const message = JSON.parse(data) as {
      id?: number;
      result?: unknown;
      error?: { message?: string };
    };
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      return;
    }
    pending.resolve(message.result);
  }
}

function rowsFromResponse(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.data)) return value.data;
  if (isRecord(value.data) && Array.isArray(value.data.rows)) return value.data.rows;
  if (isRecord(value.data) && Array.isArray(value.data.list)) return value.data.list;
  return [];
}

function pickString(value: unknown, paths: string[]): string | null {
  for (const path of paths) {
    const found = path.split(".").reduce<unknown>((current, key) => {
      return isRecord(current) ? current[key] : undefined;
    }, value);
    const text = stringValue(found);
    if (text !== null) return text;
  }
  return null;
}

function firstString(value: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const text = stringValue(value[key]);
    if (text !== null) return text;
  }
  return null;
}

function withQuery(url: URL, params: Record<string, string | number>): URL {
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeRoxyWorkspaceId(value: string | number | null): string | number | null {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  const displayMatch = /^[A-Z]+0*([0-9]+)$/i.exec(trimmed);
  if (displayMatch !== null) {
    return Number.parseInt(displayMatch[1]!, 10);
  }
  return trimmed;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return values.length === value.length ? values : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}
