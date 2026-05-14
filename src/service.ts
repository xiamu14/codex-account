import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists, removePath } from "./fs.ts";
import { autoQuotaPidPath } from "./paths.ts";

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
    process.kill(existingPid, "SIGTERM");
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
