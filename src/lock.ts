import { mkdir, rm, writeFile } from 'node:fs/promises';
import { lockPath } from './paths.ts';

export async function withLock<T>(appHome: string, run: () => Promise<T>): Promise<T> {
  const target = lockPath(appHome);
  try {
    await mkdir(target, { recursive: false });
  } catch {
    throw new Error('另一个 cxa 操作正在运行，请稍后重试。');
  }

  try {
    await writeFile(`${target}/owner`, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
    return await run();
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}
