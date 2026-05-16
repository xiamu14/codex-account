import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withLock } from "../src/lock.ts";
import { lockPath } from "../src/paths.ts";

async function makeAppHome(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "cxa-lock-"));
}

describe("withLock", () => {
  test("removes the lock after a successful operation", async () => {
    const appHome = await makeAppHome();

    await withLock(appHome, async () => undefined);

    await expect(readFile(path.join(lockPath(appHome), "owner"), "utf8")).rejects.toThrow();
  });

  test("cleans up a stale lock whose owner process no longer exists", async () => {
    const appHome = await makeAppHome();
    const target = lockPath(appHome);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "owner"), "999999\n2026-05-12T00:00:00.000Z\n", "utf8");

    let ran = false;
    await withLock(appHome, async () => {
      ran = true;
    });

    expect(ran).toBe(true);
  });

  test("rejects when the owner process is still alive", async () => {
    const appHome = await makeAppHome();
    const target = lockPath(appHome);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "owner"), `${process.pid}\n2026-05-12T00:00:00.000Z\n`, "utf8");

    await expect(withLock(appHome, async () => undefined)).rejects.toThrow(
      "另一个 bun cli 操作正在运行",
    );
  });

  test("does not reclaim an old lock while the owner process is still alive", async () => {
    const appHome = await makeAppHome();
    const target = lockPath(appHome);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "owner"), `${process.pid}\n2026-05-12T00:00:00.000Z\n`, "utf8");
    const old = new Date(Date.now() - 5 * 60_000);
    await utimes(target, old, old);

    await expect(withLock(appHome, async () => undefined)).rejects.toThrow(
      "另一个 bun cli 操作正在运行",
    );
  });

  test("waits for a running operation when requested", async () => {
    const appHome = await makeAppHome();
    const first = withLock(appHome, async () => {
      await sleep(80);
    });
    await sleep(10);

    let ran = false;
    await withLock(
      appHome,
      async () => {
        ran = true;
      },
      { waitMs: 1_000, retryIntervalMs: 10 },
    );
    await first;

    expect(ran).toBe(true);
  });
});

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
