import { mkdir, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { CommandContext } from "./types.ts";

const PORTLESS_PROXY_PORT = 1_355;
const PORTLESS_NAME = "codexaccount";
const UI_APP_PORT = 41_739;
const WEB_LABEL = "com.codex-account.web";
const QUOTA_LABEL = "com.codex-account.quota";

type LaunchdService = {
  label: string;
  plistPath: string;
  programArguments: string[];
};

export async function installLaunchdServices(
  context: CommandContext,
): Promise<void> {
  assertMacOS();
  const projectRoot = resolveProjectRoot();
  const portlessBin = path.join(projectRoot, "node_modules", ".bin", "portless");
  const logsRoot = path.join(context.appHome, "logs");

  await mkdir(launchAgentsRoot(), { recursive: true });
  await mkdir(logsRoot, { recursive: true });
  await buildWebUi(projectRoot);

  for (const service of buildServices(projectRoot, portlessBin)) {
    await writeFile(
      service.plistPath,
      renderPlist({
        context,
        label: service.label,
        logsRoot,
        programArguments: service.programArguments,
        workingDirectory: projectRoot,
      }),
      "utf8",
    );
  }
}

export async function uninstallLaunchdServices(
  _context?: CommandContext,
): Promise<void> {
  assertMacOS();
  await stopLaunchdServices();
  for (const service of buildServices(resolveProjectRoot(), "")) {
    await rm(service.plistPath, { force: true });
  }
}

export async function startLaunchdServices(
  context: CommandContext,
): Promise<void> {
  assertMacOS();
  await installLaunchdServices(context);
  for (const service of buildServices(resolveProjectRoot(), "")) {
    await launchctl(["bootout", launchDomain(), service.plistPath], true);
    await launchctl(["bootstrap", launchDomain(), service.plistPath], false);
  }
}

export async function stopLaunchdServices(
  _context?: CommandContext,
): Promise<void> {
  assertMacOS();
  for (const service of buildServices(resolveProjectRoot(), "")) {
    await launchctl(["bootout", launchDomain(), service.plistPath], true);
  }
}

export function renderServiceStartMessage(cliUsage: string): string {
  return [
    "Web UI:",
    `  http://${PORTLESS_NAME}.localhost:${PORTLESS_PROXY_PORT}`,
    "",
    "CLI:",
    cliUsage,
  ].join("\n");
}

async function buildWebUi(projectRoot: string): Promise<void> {
  try {
    await runProcess(process.execPath, ["run", "build:ui"], { cwd: projectRoot });
  } catch (error) {
    throw new Error(`Web UI 构建失败：${formatExecError(error)}`);
  }
}

function buildServices(projectRoot: string, portlessBin: string): LaunchdService[] {
  const entrypoint = path.join(projectRoot, "src", "main.ts");
  return [
    {
      label: WEB_LABEL,
      plistPath: path.join(launchAgentsRoot(), `${WEB_LABEL}.plist`),
      programArguments: [
        portlessBin || path.join(projectRoot, "node_modules", ".bin", "portless"),
        PORTLESS_NAME,
        "--app-port",
        String(UI_APP_PORT),
        "--",
        process.execPath,
        entrypoint,
        "ui",
        "--serve",
      ],
    },
    {
      label: QUOTA_LABEL,
      plistPath: path.join(launchAgentsRoot(), `${QUOTA_LABEL}.plist`),
      programArguments: [
        process.execPath,
        entrypoint,
        "quota",
        "--service",
      ],
    },
  ];
}

function renderPlist(options: {
  context: CommandContext;
  label: string;
  logsRoot: string;
  programArguments: string[];
  workingDirectory: string;
}): string {
  const env = {
    CODEX_HOME: options.context.codexHome,
    CXA_CODEX_BIN: options.context.codexBin,
    CXA_HOME: options.context.appHome,
    PATH: renderLaunchdPath(options.context),
    PORTLESS_HTTPS: "0",
    PORTLESS_PORT: String(PORTLESS_PROXY_PORT),
  };

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(options.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...options.programArguments.map(
      (argument) => `    <string>${escapeXml(argument)}</string>`,
    ),
    "  </array>",
    "  <key>WorkingDirectory</key>",
    `  <string>${escapeXml(options.workingDirectory)}</string>`,
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...Object.entries(env).flatMap(([key, value]) => [
      `    <key>${escapeXml(key)}</key>`,
      `    <string>${escapeXml(value)}</string>`,
    ]),
    "  </dict>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(path.join(options.logsRoot, `${options.label}.out.log`))}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(path.join(options.logsRoot, `${options.label}.err.log`))}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function renderLaunchdPath(context: CommandContext): string {
  return [
    path.dirname(process.execPath),
    path.dirname(context.codexBin),
    path.join(resolveProjectRoot(), "node_modules", ".bin"),
    process.env.PATH ?? "",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]
    .flatMap((entry) => entry.split(":"))
    .filter((entry, index, entries) => {
      return entry.trim().length > 0 && entries.indexOf(entry) === index;
    })
    .join(":");
}

async function launchctl(args: string[], ignoreFailure: boolean): Promise<void> {
  try {
    await runProcess("/bin/launchctl", args);
  } catch (error) {
    if (ignoreFailure) return;
    throw new Error(`launchctl 执行失败：${formatExecError(error)}`);
  }
}

async function runProcess(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<void> {
  const spawnOptions = {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  } as const;

  const child = Bun.spawn([command, ...args], spawnOptions);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    child.exited,
  ]);

  if (exitCode !== 0) {
    throw new ProcessError(command, args, exitCode, stdout, stderr);
  }
}

function launchDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error("当前运行环境无法读取用户 ID。");
  }
  return `gui/${uid}`;
}

function launchAgentsRoot(): string {
  return path.join(homedir(), "Library", "LaunchAgents");
}

function resolveProjectRoot(): string {
  return path.resolve(import.meta.dir, "..");
}

function assertMacOS(): void {
  if (process.platform !== "darwin") {
    throw new Error("install/start/stop/uninstall 目前只支持 macOS。");
  }
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function formatExecError(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "stderr" in error &&
    typeof error.stderr === "string" &&
    error.stderr.trim().length > 0
  ) {
    return error.stderr.trim();
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

class ProcessError extends Error {
  constructor(
    command: string,
    args: string[],
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${command} ${args.join(" ")} exited with code ${exitCode}`);
  }
}
