import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { lockPath } from './paths.ts';

export async function withLock<T>(appHome: string, run: () => Promise<T>): Promise<T> {
  const target = lockPath(appHome);
  await acquireLock(target);

  try {
    await writeFile(`${target}/owner`, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
    return await run();
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}

async function acquireLock(target: string): Promise<void> {
  try {
    await mkdir(target, { recursive: false });
    return;
  } catch {
    if (await isStaleLock(target)) {
      await rm(target, { recursive: true, force: true });
      try {
        await mkdir(target, { recursive: false });
        return;
      } catch {
        throw new Error('另一个 cxa 操作正在运行，请稍后再试。');
      }
    }
    throw new Error('另一个 cxa 操作正在运行，请稍后再试。');
  }
}

async function isStaleLock(target: string): Promise<boolean> {
  try {
    const owner = await readFile(`${target}/owner`, 'utf8');
    const pid = Number.parseInt(owner.split(/\r?\n/)[0] ?? '', 10);
    if (!Number.isFinite(pid) || pid <= 0) return await isOldLock(target);
    return !isProcessAlive(pid);
  } catch {
    return await isOldLock(target);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ESRCH'
    ) {
      return false;
    }
    return true;
  }
}

async function isOldLock(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    return Date.now() - info.mtimeMs > 30_000;
  } catch {
    return false;
  }
}
