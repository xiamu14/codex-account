import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists, removePath } from "./fs.ts";
import {
  AUTO_QUOTA_MIN_INTERVAL_MINUTES,
  writeAutoQuotaState,
} from "./auto-quota.ts";
import { autoQuotaPidPath } from "./paths.ts";
import type { AutoQuotaState, CommandContext } from "./types.ts";

const AUTO_QUOTA_RECOVERY_DELAY_MS = AUTO_QUOTA_MIN_INTERVAL_MINUTES * 60_000;
const AUTO_QUOTA_RECOVERY_GRACE_MS = 60_000;

export async function startAutoQuotaService(options: {
  bunBin: string;
  scriptPath: string;
  cwd: string;
  appHome: string;
  codexHome: string;
  codexBin: string;
}): Promise<{ started: boolean; pid: number | null }> {
  const existingPid = await readAutoQuotaPid(options.appHome);
  if (existingPid !== null && isProcessRunning(existingPid)) {
    return { started: false, pid: existingPid };
  }

  await removePath(autoQuotaPidPath(options.appHome));
  await mkdir(options.appHome, { recursive: true });
  const child = spawn(options.bunBin, [options.scriptPath, "quota", "--service"], {
    cwd: options.cwd,
    detached: true,
    env: {
      ...process.env,
      CXA_HOME: options.appHome,
      CODEX_HOME: options.codexHome,
      CXA_CODEX_BIN: options.codexBin,
      PATH: renderServicePath(options),
    },
    stdio: "ignore",
  });
  child.unref();

  const pid = child.pid ?? null;
  if (pid !== null) {
    await writeFile(autoQuotaPidPath(options.appHome), `${pid}\n`, "utf8");
  }
  return { started: true, pid };
}

export async function registerAutoQuotaServiceProcess(
  appHome: string,
  pid: number = process.pid,
): Promise<boolean> {
  const existingPid = await readAutoQuotaPid(appHome);
  if (
    existingPid !== null &&
    existingPid !== pid &&
    isProcessRunning(existingPid)
  ) {
    return false;
  }
  await mkdir(appHome, { recursive: true });
  await writeFile(autoQuotaPidPath(appHome), `${pid}\n`, "utf8");
  return true;
}

export async function unregisterAutoQuotaServiceProcess(
  appHome: string,
  pid: number = process.pid,
): Promise<void> {
  const existingPid = await readAutoQuotaPid(appHome);
  if (existingPid !== pid) return;
  await rm(autoQuotaPidPath(appHome), { force: true });
}

export async function stopAutoQuotaService(appHome: string): Promise<boolean> {
  const pid = await readAutoQuotaPid(appHome);
  await removePath(autoQuotaPidPath(appHome));
  if (pid === null || !isProcessRunning(pid)) {
    return false;
  }
  process.kill(pid, "SIGTERM");
  return true;
}

export async function isAutoQuotaServiceRunning(appHome: string): Promise<boolean> {
  const pid = await readAutoQuotaPid(appHome);
  return pid !== null && isProcessRunning(pid);
}

export async function recoverAutoQuotaServiceIfNeeded(
  context: CommandContext,
  state: AutoQuotaState,
): Promise<{ serviceRunning: boolean; recovered: boolean }> {
  if (!state.enabled) {
    return {
      serviceRunning: await isAutoQuotaServiceRunning(context.appHome),
      recovered: false,
    };
  }

  const serviceRunning = await isAutoQuotaServiceRunning(context.appHome);
  const missedCheckCount = resolveMissedCheckCount(state, new Date());
  if (serviceRunning && missedCheckCount === null) {
    return { serviceRunning: true, recovered: false };
  }

  if (missedCheckCount !== null) {
    const now = new Date();
    await writeAutoQuotaState(context.appHome, {
      ...state,
      lastWakeAt: now.toISOString(),
      lastMissedCheckCount: missedCheckCount,
      nextCheckAt: new Date(
        now.getTime() + AUTO_QUOTA_RECOVERY_DELAY_MS,
      ).toISOString(),
    });
  }

  await startAutoQuotaService({
    bunBin: process.execPath,
    scriptPath: path.resolve(process.argv[1] ?? "src/main.ts"),
    cwd: context.cwd,
    appHome: context.appHome,
    codexHome: context.codexHome,
    codexBin: context.codexBin,
  });

  return {
    serviceRunning: await isAutoQuotaServiceRunning(context.appHome),
    recovered: true,
  };
}

function resolveMissedCheckCount(
  state: AutoQuotaState,
  now: Date,
): number | null {
  if (!state.enabled || state.nextCheckAt === null) return null;
  const nextCheckAt = new Date(state.nextCheckAt);
  if (Number.isNaN(nextCheckAt.getTime())) return null;
  const lateMs = now.getTime() - nextCheckAt.getTime();
  if (lateMs < AUTO_QUOTA_RECOVERY_GRACE_MS) return null;
  return Math.max(1, Math.floor(lateMs / AUTO_QUOTA_RECOVERY_DELAY_MS));
}

async function readAutoQuotaPid(appHome: string): Promise<number | null> {
  const pidPath = autoQuotaPidPath(appHome);
  if (!(await pathExists(pidPath))) return null;
  const text = await readFile(pidPath, "utf8");
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    ) {
      return false;
    }
    return true;
  }
}

function renderServicePath(options: {
  bunBin: string;
  codexBin: string;
}): string {
  const entries = [
    path.dirname(options.bunBin),
    path.dirname(options.codexBin),
    process.env.PATH ?? "",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].flatMap((entry) => entry.split(":"));
  return [...new Set(entries.filter((entry) => entry.trim().length > 0))].join(":");
}
