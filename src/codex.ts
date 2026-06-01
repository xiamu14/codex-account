import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { copyFileAtomic, pathExists, removePath } from "./fs.ts";
import { runsRoot } from "./paths.ts";

const execFileAsync = promisify(execFile);
const UNIVERSAL_BROWSER_LOGIN_TYPE = "chatgpt";
const APP_SERVER_CLIENT_INFO = {
  name: "codex",
  title: "Codex CLI",
  version: "0.1.0",
};

export async function resolveCodexBin(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const explicit = env.CXA_CODEX_BIN?.trim();
  if (explicit) return explicit;

  for (const entry of (env.PATH ?? process.env.PATH ?? "").split(":")) {
    if (entry.trim().length === 0) continue;
    const candidate = path.join(entry, "codex");
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching PATH entries.
    }
  }

  return "codex";
}

export async function runCodexLogin(
  codexBin: string,
  accountHome: string,
  cwd: string,
  options: {
    handleAuthUrl?: (authUrl: string) => Promise<void>;
    authCompletionGraceMs?: number;
    printFullAuthUrl?: boolean;
  } = {},
): Promise<void> {
  await mkdir(accountHome, { recursive: true });
  await runBrowserLoginWithoutOpeningBrowser(codexBin, accountHome, cwd, options);
}

export async function runCodexCall(
  codexBin: string,
  codexHome: string,
  cwd: string,
  prompt: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const outputPath = path.join(codexHome, `call-output-${randomUUID()}.txt`);
    const child = spawn(
      codexBin,
      [
        "exec",
        "--ephemeral",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--color",
        "never",
        "--output-last-message",
        outputPath,
        prompt,
      ],
      {
        cwd,
        env: {
          ...process.env,
          CODEX_HOME: codexHome,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("codex exec 超时。"));
    }, 60_000);

    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (code === 0) {
        resolve(
          formatCallOutput(
            await readFile(outputPath, "utf8").catch(() =>
              Buffer.concat(chunks).toString("utf8"),
            ),
          ),
        );
        return;
      }
      const output = Buffer.concat([...chunks, ...errors]).toString("utf8");
      reject(
        new Error(
          output.trim() ||
            `codex exec 失败：${code ?? "unknown"}。`,
        ),
      );
    });
  });
}

function formatCallOutput(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1) ?? "无回复";
}

async function runCodex(
  codexBin: string,
  args: string[],
  codexHome: string,
  cwd: string,
  mode: "inherit" | "pipe-login",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(codexBin, args, {
      cwd,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
      stdio: mode === "inherit" ? "inherit" : ["inherit", "pipe", "pipe"],
    });

    if (mode === "pipe-login") {
      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        printLoginOutput(text);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        printLoginOutput(text);
      });
    }

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `codex ${args.join(" ")} 失败，退出码 ${code ?? "unknown"}。`,
          ),
        );
      }
    });
  });
}

function printLoginOutput(text: string): void {
  const urls = text.match(/https?:\/\/\S+/g) ?? [];
  if (urls.length > 0) {
    for (const url of urls) {
      process.stdout.write(`登录链接：${url}\n`);
    }
    return;
  }
  process.stdout.write(text);
}

async function runBrowserLoginWithoutOpeningBrowser(
  codexBin: string,
  codexHome: string,
  cwd: string,
  options: {
    handleAuthUrl?: (authUrl: string) => Promise<void>;
    authCompletionGraceMs?: number;
    printFullAuthUrl?: boolean;
  } = {},
): Promise<void> {
  const authPath = path.join(codexHome, "auth.json");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(codexBin, ["app-server", "--listen", "stdio://"], {
      cwd,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let settled = false;
    let initialized = false;
    let loginStarted = false;
    const timeout = setTimeout(
      () => {
        finish(() => reject(new Error("登录超时。请重新运行 bun cli login。")));
      },
      15 * 60 * 1000,
    );
    const poll = setInterval(async () => {
      if (await pathExists(authPath)) {
        if ((options.authCompletionGraceMs ?? 0) > 0) {
          clearInterval(poll);
          setTimeout(() => finish(resolve), options.authCompletionGraceMs);
          return;
        }
        finish(resolve);
      }
    }, 1000);

    function finish(result: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(poll);
      child.stdin.end();
      child.kill();
      result();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const output = Buffer.concat(chunks).toString("utf8");
      const messages = parseJsonLines(output);
      if (!initialized && messages.some((message) => message.id === 1)) {
        initialized = true;
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "initialized" })}\n`,
        );
        child.stdin.write(`${JSON.stringify(browserLoginStartRequest(2))}\n`);
      }

      const loginMessage = messages.find((message) => message.id === 2);
      if (!loginStarted && loginMessage !== undefined) {
        loginStarted = true;
        if (loginMessage.error !== undefined) {
          finish(() =>
            reject(
              new Error(
                formatAppServerFailure("登录启动失败", output, loginMessage),
              ),
            ),
          );
          return;
        }
        const authUrl = extractAuthUrl(loginMessage.result);
        if (authUrl === null) {
          finish(() =>
            reject(
              new Error(
                formatAppServerFailure(
                  "没有收到登录链接",
                  output,
                  loginMessage,
                ),
              ),
            ),
          );
          return;
        }
        process.stdout.write(`登录链接：${formatLoginUrlForOutput(authUrl, options.printFullAuthUrl ?? options.handleAuthUrl === undefined)}\n`);
        if (options.handleAuthUrl === undefined) {
          process.stdout.write("打开链接完成登录。\n");
          return;
        }
        options.handleAuthUrl(authUrl).catch((error) => {
          finish(() => reject(error));
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", (error) => {
      finish(() => reject(error));
    });
    child.on("exit", (code) => {
      if (settled) return;
      const output = Buffer.concat([...chunks, ...errors]).toString("utf8");
      reject(
        new Error(
          output.trim() ||
            `登录未完成：${code ?? "unknown"}。`,
        ),
      );
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: APP_SERVER_CLIENT_INFO,
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: [],
          },
        },
      })}\n`,
    );
  });
}

function formatLoginUrlForOutput(authUrl: string, printFull: boolean): string {
  if (printFull) return authUrl;
  try {
    const url = new URL(authUrl);
    return `${url.origin}${url.pathname}?...`;
  } catch {
    return "<已省略>";
  }
}

export function browserLoginStartRequest(id: number): JsonRpcRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: "account/login/start",
    params: {
      // Codex currently names the universal OpenAI browser sign-in flow "chatgpt".
      // The returned authUrl is still the generic login page where users can choose email,
      // Outlook/Microsoft, Google, or another supported provider.
      type: UNIVERSAL_BROWSER_LOGIN_TYPE,
    },
  };
}

type JsonRpcMessage = {
  id?: number;
  result?: unknown;
  error?: unknown;
};

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

function parseJsonLines(output: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as JsonRpcMessage;
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        ("result" in parsed || "error" in parsed)
      ) {
        messages.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return messages;
}

function extractAuthUrl(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("authUrl" in value))
    return null;
  const authUrl = (value as { authUrl?: unknown }).authUrl;
  return typeof authUrl === "string" && authUrl.length > 0 ? authUrl : null;
}

function formatAppServerFailure(
  title: string,
  output: string,
  message: JsonRpcMessage,
): string {
  const details = [title];
  if (message.error !== undefined) {
    details.push(`原因：${JSON.stringify(message.error)}`);
  }
  const trimmed = output.trim();
  if (trimmed.length > 0) {
    details.push("输出：");
    details.push(trimmed);
  }
  return details.join("\n");
}

export async function prepareAcpHome(options: {
  appHome: string;
  codexHome: string;
  authPath: string;
}): Promise<string> {
  const acpHome = path.join(runsRoot(options.appHome), `acp-${randomUUID()}`);
  await mkdir(acpHome, { recursive: true });
  await copyFile(options.authPath, path.join(acpHome, "auth.json"));

  const configPath = path.join(options.codexHome, "config.toml");
  if (await pathExists(configPath)) {
    await copyFile(configPath, path.join(acpHome, "config.toml"));
  }

  for (const entry of ["AGENTS.md", "mcp.json"]) {
    const source = path.join(options.codexHome, entry);
    if (await pathExists(source)) {
      await copyFile(source, path.join(acpHome, entry));
    }
  }

  const sessions = path.join(options.codexHome, "sessions");
  if (await pathExists(sessions)) {
    await symlink(sessions, path.join(acpHome, "sessions"), "dir").catch(
      () => undefined,
    );
  } else {
    await mkdir(path.join(acpHome, "sessions"), { recursive: true });
  }

  for (const entry of ["history.jsonl", "session_index.jsonl"]) {
    const source = path.join(options.codexHome, entry);
    if (await pathExists(source)) {
      await symlink(source, path.join(acpHome, entry)).catch(() => undefined);
    } else {
      await writeFile(path.join(acpHome, entry), "", "utf8");
    }
  }

  return acpHome;
}

export async function cleanupRunHome(runHome: string): Promise<void> {
  await removePath(runHome);
}

export async function activateAuth(
  authPath: string,
  codexHome: string,
): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  await copyFileAtomic(authPath, path.join(codexHome, "auth.json"));
}

export async function hasCodexAuth(codexHome: string): Promise<boolean> {
  return pathExists(path.join(codexHome, "auth.json"));
}

export async function listRunHomes(appHome: string): Promise<string[]> {
  try {
    return await readdir(runsRoot(appHome));
  } catch {
    return [];
  }
}
