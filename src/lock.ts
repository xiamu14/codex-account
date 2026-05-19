import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { lockPath } from "./paths.ts";

const BROKEN_LOCK_TTL_MS = 30_000;
const DEFAULT_LOCK_RETRY_INTERVAL_MS = 500;

type LockOptions = {
  waitMs?: number | undefined;
  retryIntervalMs?: number | undefined;
};

function isProcessAlive(pid: number): boolean {
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

export async function withLock<T>(
  appHome: string,
  run: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const target = lockPath(appHome);
  await acquireLock(target, options);

  try {
    await writeFile(
      `${target}/owner`,
      `${process.pid}\n${new Date().toISOString()}\n`,
      "utf8",
    );
    return await run();
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}

async function acquireLock(
  target: string,
  options: LockOptions = {},
): Promise<void> {
  const startedAt = Date.now();
  const waitMs = Math.max(0, options.waitMs ?? 0);
  const retryIntervalMs = Math.max(
    50,
    options.retryIntervalMs ?? DEFAULT_LOCK_RETRY_INTERVAL_MS,
  );

  while (true) {
    const result = await tryAcquireLock(target);
    if (result) return;
    if (Date.now() - startedAt >= waitMs) {
      throw new Error("后台服务正在运行，请稍后再试。");
    }
    await sleep(Math.min(retryIntervalMs, waitMs - (Date.now() - startedAt)));
  }
}

async function tryAcquireLock(target: string): Promise<boolean> {
  try {
    await mkdir(target, { recursive: false });
    return true;
  } catch {
    if (await isStaleLock(target)) {
      await rm(target, { recursive: true, force: true });
      try {
        await mkdir(target, { recursive: false });
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

async function isStaleLock(target: string): Promise<boolean> {
  try {
    const owner = await readFile(`${target}/owner`, "utf8");
    const pid = Number.parseInt(owner.split(/\r?\n/)[0] ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0)
      return await isBrokenLockOldEnough(target);
    return !isProcessAlive(pid);
  } catch {
    return await isBrokenLockOldEnough(target);
  }
}

async function isBrokenLockOldEnough(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    return Date.now() - info.mtimeMs > BROKEN_LOCK_TTL_MS;
  } catch {
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}
