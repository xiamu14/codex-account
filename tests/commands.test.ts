import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  callCommand,
  deactiveCommand,
  deleteCommand,
  findSavedAccount,
  loginCommand,
  quotaCommand,
  refreshCommand,
  resolveAccountTarget,
  saveCommand,
  updateSubscriptionDateCommand,
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

describe("updateSubscriptionDateCommand", () => {
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

    await updateSubscriptionDateCommand(context, "2026-06-01", "user@example.com");

    const meta = await store.readMeta("user@example.com");
    expect(meta?.subscriptionExpiresAt).toContain("2026-06-01");
  });

  test("rejects invalid date format", async () => {
    const context = await makeContext();
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"one"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("user@example.com", authPath, {
      email: "user@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });

    await expect(
      updateSubscriptionDateCommand(context, "2026/06/01", "user@example.com"),
    ).rejects.toThrow("YYYY-MM-DD");
  });

  test("falls back to the only stored account when alias is omitted", async () => {
    const context = await makeContext();
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"one"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("user@example.com", authPath, {
      email: "user@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });

    await updateSubscriptionDateCommand(context, "2026-06-01");

    const meta = await store.readMeta("user@example.com");
    expect(meta?.subscriptionExpiresAt).toContain("2026-06-01");
  });
});

describe("saveCommand", () => {
  test("rejects when Codex is not logged in", async () => {
    const context = await makeContext();

    await expect(saveCommand(context, "user@example.com")).rejects.toThrow(
      "当前 Codex 没有登录",
    );
  });

  test("saves the current Codex login with the requested alias", async () => {
    const output = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    context.codexBin = await writeFakeCodex(context.appHome);
    await mkdir(context.codexHome, { recursive: true });
    await writeFile(path.join(context.codexHome, "auth.json"), '{"token":"live"}', "utf8");

    await saveCommand(context, "work");

    const store = new AccountStore(context.appHome);
    const summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.alias).toBe("work");
    expect(summaries[0]?.isActive).toBe(true);
    expect(summaries[0]?.meta?.email).toBe("fresh@example.com");
    expect(await readFile(await store.authPath("work"), "utf8")).toBe('{"token":"live"}');
    expect(output.text).toContain("已保存并激活账号 work");
  });

  test("only reports when the current login is already saved", async () => {
    const output = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    context.codexBin = await writeFakeCodex(context.appHome);
    await mkdir(context.codexHome, { recursive: true });
    await writeFile(path.join(context.codexHome, "auth.json"), '{"token":"live"}', "utf8");
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"one"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("saved", authPath, {
      email: "fresh@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });

    await saveCommand(context, "other");

    expect(output.text).toContain("已保存");
    expect(await store.listSummaries()).toHaveLength(1);
  });
});

describe("loginCommand", () => {
  test("logs in with an isolated Codex home and saves the account without activating it", async () => {
    const output = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    context.codexBin = await writeRefreshFakeCodex(context.appHome);

    await loginCommand(context, "new-account");

    const store = new AccountStore(context.appHome);
    const summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.alias).toBe("new-account");
    expect(summaries[0]?.isActive).toBe(false);
    expect(await readFile(await store.authPath("new-account"), "utf8")).toBe('{"token":"fresh"}');
    await expect(readFile(path.join(context.codexHome, "auth.json"), "utf8")).rejects.toThrow();
    expect(output.text).toContain("登录完成，已保存账号 new-account");
  });
});

describe("deactiveCommand", () => {
  test("only clears the current account without running codex logout", async () => {
    const output = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    context.codexBin = await writeLogoutFailingCodex(context.appHome);
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"saved"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("user@example.com", authPath, {
      email: "user@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });
    await store.setActive("user@example.com");
    await writeLiveAuth(context, "live");

    await deactiveCommand(context);

    await expect(readFile(path.join(context.codexHome, "auth.json"), "utf8")).rejects.toThrow();
    expect((await store.listSummaries())[0]?.isActive).toBe(false);
    expect(await readFile(await store.authPath("user@example.com"), "utf8")).toBe('{"token":"saved"}');
    expect(output.text).toContain("已退出当前 Codex 账号");
  });
});

describe("deleteCommand", () => {
  test("deletes only the stored account without running codex logout", async () => {
    const output = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    context.codexBin = await writeLogoutFailingCodex(context.appHome);
    const authPath = path.join(context.appHome, "auth.json");
    await writeFile(authPath, '{"token":"saved"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("user@example.com", authPath, {
      email: "user@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });
    await writeLiveAuth(context, "live");

    await deleteCommand(context, "user@example.com");

    expect(await store.listSummaries()).toHaveLength(0);
    expect(await readFile(path.join(context.codexHome, "auth.json"), "utf8")).toBe('{"token":"live"}');
    expect(output.text).toContain("已删除账号 user@example.com");
  });
});

describe("quotaCommand", () => {
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

    await quotaCommand(context);

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

    await quotaCommand(context);

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

    await quotaCommand(context);

    expect(errorOutput.text).toContain(
      "user@example.com: token 已失效。运行 cxa refresh user@example.com 后重新登录。",
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

    await quotaCommand(context);

    const summaries = await store.listSummaries();
    expect(summaries[0]?.isActive).toBe(false);
    expect(errorOutput.text).toContain(
      "token 失效的 active 账号已自动 deactive：user@example.com",
    );
  });
});

describe("callCommand", () => {
  test("calls all stored accounts concurrently", async () => {
    const output = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    context.codexBin = await writeCallFakeCodex(context.appHome);
    const firstAuth = path.join(context.appHome, "first-auth.json");
    const secondAuth = path.join(context.appHome, "second-auth.json");
    await writeFile(firstAuth, '{"token":"one"}', "utf8");
    await writeFile(secondAuth, '{"token":"two"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("one@example.com", firstAuth, {
      email: "one@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });
    await store.createAccount("two@example.com", secondAuth, {
      email: "two@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });

    await callCommand(context);

    expect(output.text).toContain("已 call one@example.com: 发送「");
    expect(output.text).toContain("已 call two@example.com: 发送「");
    expect(output.text).toContain("回复「OK」");
  });

  test("keeps calling other accounts when one token expired", async () => {
    const output = new CaptureStream();
    const errorOutput = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    context.stderr = errorOutput as unknown as NodeJS.WriteStream;
    context.codexBin = await writeCallFakeCodex(context.appHome);
    const goodAuth = path.join(context.appHome, "good-auth.json");
    const expiredAuth = path.join(context.appHome, "expired-auth.json");
    await writeFile(goodAuth, '{"token":"good"}', "utf8");
    await writeFile(expiredAuth, '{"token":"expired"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("good@example.com", goodAuth, {
      email: "good@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });
    await store.createAccount("expired@example.com", expiredAuth, {
      email: "expired@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });

    await callCommand(context);

    expect(output.text).toContain("已 call good@example.com: 发送「");
    expect(output.text).toContain("回复「OK」");
    expect(errorOutput.text).toContain("expired@example.com: token 已失效");
    expect(errorOutput.text).toContain("cxa refresh expired@example.com");
  });

  test("reports quota failures for selected accounts", async () => {
    const output = new CaptureStream();
    const errorOutput = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    context.stderr = errorOutput as unknown as NodeJS.WriteStream;
    context.codexBin = await writeCallFakeCodex(context.appHome);
    const authPath = path.join(context.appHome, "quota-auth.json");
    await writeFile(authPath, '{"token":"quota"}', "utf8");
    const store = new AccountStore(context.appHome);
    await store.createAccount("quota@example.com", authPath, {
      email: "quota@example.com",
      planType: "plus",
      subscriptionExpiresAt: null,
    });

    await expect(
      callCommand(context, { aliases: ["quota@example.com"] }),
    ).rejects.toThrow(
      "所有账号 call 失败",
    );

    expect(errorOutput.text).toContain("quota@example.com: 没有可用额度");
  });
});

describe("refreshCommand", () => {
  test("logs in with an isolated Codex home and refreshes the requested account", async () => {
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
    await writeLiveAuth(context, "current");

    await refreshCommand(context, "user@example.com");

    const savedAuth = await readFile(await store.authPath("user@example.com"), "utf8");
    const liveAuth = await readFile(path.join(context.codexHome, "auth.json"), "utf8");
    const meta = await store.readMeta("user@example.com");
    expect(savedAuth).toBe('{"token":"fresh"}');
    expect(liveAuth).toBe('{"token":"current"}');
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

    await refreshCommand(context);

    const savedAuth = await readFile(await store.authPath("user@example.com"), "utf8");
    expect(savedAuth).toBe('{"token":"fresh"}');
  });

  test("requires at least one stored account", async () => {
    const context = await makeContext();
    await expect(refreshCommand(context)).rejects.toThrow("没有账号可刷新 token");
  });

  test("falls back to the only stored account when alias is omitted", async () => {
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

    await refreshCommand(context);

    const savedAuth = await readFile(await store.authPath("user@example.com"), "utf8");
    expect(savedAuth).toBe('{"token":"fresh"}');
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

describe("resolveAccountTarget", () => {
  test("returns the explicit alias when one is provided", async () => {
    await expect(
      resolveAccountTarget(
        {
          version: 1,
          accounts: [{ alias: "saved@example.com", createdAt: "2026-05-11T00:00:00.000Z" }],
          activeAccount: null,
          updatedAt: "2026-05-11T00:00:00.000Z",
        },
        "manual@example.com",
        "刷新 token",
      ),
    ).resolves.toBe("manual@example.com");
  });

  test("returns null when there are no stored accounts", async () => {
    await expect(
      resolveAccountTarget(
        {
          version: 1,
          accounts: [],
          activeAccount: null,
          updatedAt: "2026-05-11T00:00:00.000Z",
        },
        undefined,
        "刷新 token",
      ),
    ).resolves.toBeNull();
  });

  test("returns the only stored account when alias is omitted", async () => {
    await expect(
      resolveAccountTarget(
        {
          version: 1,
          accounts: [{ alias: "saved@example.com", createdAt: "2026-05-11T00:00:00.000Z" }],
          activeAccount: null,
          updatedAt: "2026-05-11T00:00:00.000Z",
        },
        undefined,
        "刷新 token",
      ),
    ).resolves.toBe("saved@example.com");
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

async function writeLiveAuth(
  context: CommandContext,
  token: string,
): Promise<void> {
  await mkdir(context.codexHome, { recursive: true });
  await writeFile(path.join(context.codexHome, "auth.json"), `{"token":"${token}"}`, "utf8");
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
      "    if (message.params?.clientInfo?.name !== 'codex') {",
      "      send({ jsonrpc: '2.0', id: message.id, error: { message: `unexpected client name: ${message.params?.clientInfo?.name}` } });",
      "      return;",
      "    }",
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

async function writeCallFakeCodex(root: string): Promise<string> {
  const scriptPath = path.join(root, "fake-call-codex.mjs");
  await writeFile(
    scriptPath,
    [
      "#!/usr/bin/env node",
      'import { readFileSync } from "node:fs";',
      'import path from "node:path";',
      "if (process.argv[2] !== 'exec') { process.exit(0); }",
      "const auth = readFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8');",
      "if (auth.includes('expired')) {",
      "  process.stderr.write('401 Unauthorized token_invalidated\\n');",
      "  process.exit(1);",
      "}",
      "if (auth.includes('quota')) {",
      "  process.stderr.write('Usage limit reached\\n');",
      "  process.exit(1);",
      "}",
      "process.stdout.write('OK\\n');",
    ].join("\n"),
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}

async function writeLogoutFailingCodex(root: string): Promise<string> {
  const scriptPath = path.join(root, "fake-logout-failing-codex.mjs");
  await writeFile(
    scriptPath,
    [
      "#!/usr/bin/env node",
      "if (process.argv.includes('logout')) {",
      "  process.stderr.write('logout must not be called\\n');",
      "  process.exit(42);",
      "}",
      "process.exit(0);",
    ].join("\n"),
    "utf8",
  );
  await chmod(scriptPath, 0o755);
  return scriptPath;
}
