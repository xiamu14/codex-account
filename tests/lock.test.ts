import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
      "另一个 cxa 操作正在运行",
    );
  });
});
