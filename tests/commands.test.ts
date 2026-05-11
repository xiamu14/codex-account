import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  addCommand,
  findSavedAccount,
  loginCommand,
  refreshCommand,
  subCommand,
  updateCommand,
} from "../src/commands.ts";
import { AccountStore } from "../src/store.ts";
import type { AccountSummary, CommandContext } from "../src/types.ts";

async function makeContext(): Promise<CommandContext> {
  const appHome = await mkdtemp(path.join(tmpdir(), "cxa-command-"));
  return {
    appHome,
    codexHome: path.join(appHome, "codex"),
    codexBin: "codex",
    cwd: appHome,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
  };
}

describe("subCommand", () => {
  test("updates subscription expiry for an account", async () => {
    const context = await makeContext();
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"one"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("user@example.com", authPath, {
      email: "user@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });

    await subCommand(context, "2026-06-01", "user@example.com");

    const meta = await store.readMeta("user@example.com");
    expect(meta?.subscriptionExpiresAt).toContain("2026-06-01");
  });

  test("rejects invalid date format", async () => {
    const context = await makeContext();
    await expect(
      subCommand(context, "2026/06/01", "user@example.com"),
    ).rejects.toThrow("YYYY-MM-DD");
  });
});

describe("addCommand", () => {
  test("only reports when the requested alias is already saved", async () => {
    const output = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"one"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("user@example.com", authPath, {
      email: "user@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });

    await addCommand(context, "user@example.com");

    expect(output.text).toContain("已保存");
    expect(await store.listSummaries()).toHaveLength(1);
  });
});

describe("loginCommand", () => {
  test("logs in to the current Codex home without saving an account", async () => {
    const output = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    context.codexBin = await writeRefreshFakeCodex(context.appHome);

    await loginCommand(context);

    const liveAuth = await readFile(path.join(context.codexHome, "auth.json"), "utf8");
    const store = new AccountStore(context.appHome);
    expect(liveAuth).toBe('{"token":"fresh"}');
    expect(await store.listSummaries()).toHaveLength(0);
    expect(output.text).toContain("已完成登录");
  });
});

describe("updateCommand", () => {
  test("prints the account list after a successful update", async () => {
    const output = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    context.codexBin = await writeFakeCodex(context.appHome);
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"one"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("user@example.com", authPath, {
      email: "old@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });
    await store.setActive("user@example.com");

    await updateCommand(context);

    expect(output.text).toContain("已刷新 user@example.com");
    expect(output.text).toContain("* user@example.com");
    expect(output.text).toContain("email         fresh@example.com");
    expect(output.text).toContain("5h limit      80% left");
  });

  test("keeps updating account metadata when quota refresh fails", async () => {
    const output = new CaptureStream();
    const errorOutput = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    context.stderr = errorOutput as unknown as NodeJS.WriteStream;
    context.codexBin = await writeFakeCodex(context.appHome, {
      quotaError: "failed to fetch codex rate limits",
    });
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"one"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("user@example.com", authPath, {
      email: "old@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });

    await updateCommand(context);

    const meta = await store.readMeta("user@example.com");
    const quota = await store.readQuota("user@example.com");
    expect(meta?.email).toBe("fresh@example.com");
    expect(quota).toBeNull();
    expect(output.text).toContain("已刷新 user@example.com，额度读取失败，已保留旧额度");
    expect(errorOutput.text).toContain("部分账号额度读取失败");
    expect(errorOutput.text).toContain("ACP 读取额度信息失败");
  });

  test("prints a short refresh hint when quota fails because token was invalidated", async () => {
    const output = new CaptureStream();
    const errorOutput = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    context.stderr = errorOutput as unknown as NodeJS.WriteStream;
    context.codexBin = await writeFakeCodex(context.appHome, {
      quotaError: "failed to fetch codex rate limits: 401 Unauthorized token_invalidated",
    });
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"one"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("user@example.com", authPath, {
      email: "old@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });

    await updateCommand(context);

    expect(errorOutput.text).toContain(
      "user@example.com: token 已失效。运行 cxa login 后执行 cxa refresh user@example.com。",
    );
  });

  test("deactivates the active account when its token was invalidated", async () => {
    const errorOutput = new CaptureStream();
    const context = await makeContext();
    context.stderr = errorOutput as unknown as NodeJS.WriteStream;
    context.codexBin = await writeFakeCodex(context.appHome, {
      quotaError: "failed to fetch codex rate limits: 401 Unauthorized token_invalidated",
    });
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"one"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("user@example.com", authPath, {
      email: "old@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });
    await store.setActive("user@example.com");

    await updateCommand(context);

    const summaries = await store.listSummaries();
    expect(summaries[0]?.isActive).toBe(false);
    expect(errorOutput.text).toContain(
      "token 失效的 active 账号已自动 deactive：user@example.com",
    );
  });
});

describe("refreshCommand", () => {
  test("replaces auth for the requested account from the current Codex login", async () => {
    const output = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    context.codexBin = await writeRefreshFakeCodex(context.appHome);
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"old"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("user@example.com", authPath, {
      email: "user@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });
    await loginCommand(context);

    await refreshCommand(context, "user@example.com");

    const savedAuth = await readFile(await store.authPath("user@example.com"), "utf8");
    const liveAuth = await readFile(path.join(context.codexHome, "auth.json"), "utf8");
    const meta = await store.readMeta("user@example.com");
    expect(savedAuth).toBe('{"token":"fresh"}');
    expect(liveAuth).toBe('{"token":"fresh"}');
    expect(meta?.email).toBe("user@example.com");
    expect(output.text).toContain("已刷新 user@example.com 的 token");
  });

  test("falls back to the active account when alias is omitted", async () => {
    const context = await makeContext();
    context.codexBin = await writeRefreshFakeCodex(context.appHome);
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"old"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("user@example.com", authPath, {
      email: "user@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });
    await store.setActive("user@example.com");
    await loginCommand(context);

    await refreshCommand(context);

    const savedAuth = await readFile(await store.authPath("user@example.com"), "utf8");
    expect(savedAuth).toBe('{"token":"fresh"}');
  });

  test("requires a target account", async () => {
    const context = await makeContext();
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"old"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("user@example.com", authPath, {
      email: "user@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });

    await expect(refreshCommand(context)).rejects.toThrow("请提供账号别名");
  });

  test("rejects login for a different account", async () => {
    const context = await makeContext();
    context.codexBin = await writeRefreshFakeCodex(context.appHome, {
      email: "other@example.com",
    });
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"old"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("user@example.com", authPath, {
      email: "user@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });
    await loginCommand(context);

    await expect(refreshCommand(context, "user@example.com")).rejects.toThrow(
      "不是 user@example.com",
    );

    const savedAuth = await readFile(await store.authPath("user@example.com"), "utf8");
    expect(savedAuth).toBe('{"token":"old"}');
  });
});

describe("findSavedAccount", () => {
  test("matches the current login by saved email or alias", () => {
    const accounts = [
      makeSummary("work", false, "person@example.com"),
      makeSummary("other@example.com", false, null),
    ];

    expect(
      findSavedAccount(accounts, {
        email: "person@example.com",
        planType: "plus",
        subscriptionExpiresAt: null,
      })?.alias,
    ).toBe("work");

    expect(
      findSavedAccount(accounts, {
        email: "other@example.com",
        planType: "plus",
        subscriptionExpiresAt: null,
      })?.alias,
    ).toBe("other@example.com");
  });

  test("falls back to the active account when account email is unavailable", () => {
    const accounts = [
      makeSummary("inactive", false, null),
      makeSummary("active", true, null),
    ];

    expect(
      findSavedAccount(accounts, {
        email: null,
        planType: null,
        subscriptionExpiresAt: null,
      })?.alias,
    ).toBe("active");
  });
});

function makeSummary(
  alias: string,
  isActive: boolean,
  email: string | null,
): AccountSummary {
  return {
    alias,
    isActive,
    hasAuth: true,
    meta: {
      alias,
      email,
      planType: "plus",
      subscriptionExpiresAt: null,
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T00:00:00.000Z",
    },
    quota: null,
  };
}

class CaptureStream extends Writable {
  text = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.text += chunk.toString();
    callback();
  }
}

async function writeFakeCodex(
  root: string,
  options: { quotaError?: string } = {},
): Promise<string> {
  const scriptPath = path.join(root, "fake-codex.mjs");
  const quotaLine =
    options.quotaError === undefined
      ? 'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { rateLimits: { fiveHour: { percentLeft: 80 }, weekly: { percentLeft: 55 } } } }) + "\\n");'
      : `process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 3, error: { code: -32603, message: ${JSON.stringify(options.quotaError)} } }) + "\\n");`;
  await writeFile(
    scriptPath,
    [
      "#!/usr/bin/env node",
      'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }) + "\\n");',
      'process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { account: { email: "fresh@example.com", planType: "plus" } } }) + "\\n");',
      quotaLine,
    ].join("\n"),
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function writeRefreshFakeCodex(
  root: string,
  options: { email?: string } = {},
): Promise<string> {
  const scriptPath = path.join(root, "fake-refresh-codex.mjs");
  const email = options.email ?? "user@example.com";
  await writeFile(
    scriptPath,
    [
      "#!/usr/bin/env node",
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      'import readline from "node:readline";',
      'const rl = readline.createInterface({ input: process.stdin });',
      "function send(message) { process.stdout.write(JSON.stringify(message) + '\\n'); }",
      "rl.on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') {",
      "    send({ jsonrpc: '2.0', id: message.id, result: {} });",
      "  } else if (message.method === 'account/login/start') {",
      "    mkdirSync(process.env.CODEX_HOME, { recursive: true });",
      "    writeFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), '{\"token\":\"fresh\"}');",
      "    send({ jsonrpc: '2.0', id: message.id, result: { authUrl: 'https://example.com/login' } });",
      "  } else if (message.method === 'account/read') {",
      `    send({ jsonrpc: '2.0', id: message.id, result: { account: { email: ${JSON.stringify(email)}, planType: 'plus' } } });`,
      "  }",
      "});",
    ].join("\n"),
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}
