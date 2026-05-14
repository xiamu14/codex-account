#!/usr/bin/env bun
import {
  activeCommand,
  autoQuotaStartCommand,
  autoQuotaStatusCommand,
  autoQuotaStopCommand,
  autoQuotaServiceCommand,
  autoQuotaTickCommand,
  callCommand,
  deactiveCommand,
  deleteCommand,
  listCommand,
  loginCommand,
  quotaCommand,
  refreshCommand,
  saveCommand,
  subscriptionCommand,
} from "./commands.ts";
import { resolveCodexBin } from "./codex.ts";
import { renderError } from "./format.ts";
import { resolveAppHome, resolveCodexHome } from "./paths.ts";
import { uiCommand } from "./ui.ts";
import type { CommandContext } from "./types.ts";

function usage(): string {
  const rows: Array<[command: string, description: string]> = [
    ["bun cli --help", "查看帮助"],
    ["cxa save", "保存当前账号"],
    ["cxa login", "登录并保存账号"],
    ["cxa list", "查看账号"],
    ["cxa active", "激活账号"],
    ["cxa deactive", "退出当前账号"],
    ["cxa delete", "删除账号"],
    ["cxa call", "刷新 quota 状态"],
    ["cxa call --select", "选择账号刷新状态"],
    ["cxa quota", "刷新额度"],
    ["cxa quota --select", "选择账号刷新额度"],
    ["cxa quota --start", "开启自动刷新"],
    ["cxa quota --stop", "停止自动刷新"],
    ["cxa quota --status", "查看自动刷新"],
    ["cxa refresh", "刷新账号 token"],
    ["cxa subscription", "更新订阅日期"],
    ["cxa ui", "打开账号状态 Web UI"],
  ];
  const commandWidth = Math.max(...rows.map(([command]) => command.length));
  return [
    "用法:",
    ...rows.map(([command, description]) => {
      return `  ${command.padEnd(commandWidth)}  ${description}`;
    }),
  ].join("\n");
}

async function buildContext(): Promise<CommandContext> {
  return {
    appHome: resolveAppHome(),
    codexHome: resolveCodexHome(),
    codexBin: await resolveCodexBin(),
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
  };
}

async function run(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const context = await buildContext();
  switch (command) {
    case "save": {
      if (argv[1] !== undefined) {
        throw new Error("save 不需要参数。");
      }
      await saveCommand(context);
      return 0;
    }

    case "login":
      if (argv[1] !== undefined) {
        throw new Error("login 不需要参数。");
      }
      await loginCommand(context);
      return 0;
    case "list":
      await listCommand(context);
      return 0;
    case "active":
      await activeCommand(context, argv[1]);
      return 0;
    case "deactive":
      await deactiveCommand(context);
      return 0;
    case "delete":
      await deleteCommand(context, argv[1]);
      return 0;
    case "call":
      if (argv[1] !== undefined && argv[1] !== "--select") {
        throw new Error("call 只支持 --select。");
      }
      if (argv[2] !== undefined)
        throw new Error("call 只支持一个参数。");
      await callCommand(context, { select: argv[1] === "--select" });
      return 0;
    case "quota":
      if (argv[2] !== undefined) {
        throw new Error("quota 只支持一个参数。");
      }
      if (argv[1] === "--start") {
        await autoQuotaStartCommand(context);
        return 0;
      }
      if (argv[1] === "--stop") {
        await autoQuotaStopCommand(context);
        return 0;
      }
      if (argv[1] === "--status") {
        await autoQuotaStatusCommand(context);
        return 0;
      }
      if (argv[1] === "--tick") {
        await autoQuotaTickCommand(context);
        return 0;
      }
      if (argv[1] === "--service") {
        await autoQuotaServiceCommand(context);
        return 0;
      }
      if (argv[1] !== undefined && argv[1] !== "--select") {
        throw new Error("quota 只支持 --select、--start、--stop、--status。");
      }
      await quotaCommand(context, { select: argv[1] === "--select" });
      return 0;
    case "refresh":
      if (argv[2] !== undefined)
        throw new Error("refresh 最多接收一个账号。");
      await refreshCommand(context, argv[1]);
      return 0;

    case "subscription": {
      if (argv[1] !== undefined) {
        throw new Error(
          "subscription 不需要参数。",
        );
      }
      await subscriptionCommand(context);
      return 0;
    }
    case "ui": {
      const port = parseUiPort(argv.slice(1));
      await uiCommand(context, port === undefined ? {} : { port });
      return 0;
    }
    default:
      throw new Error(`未知命令：${command}\n${usage()}`);
  }
}

function parseUiPort(argv: string[]): number | undefined {
  if (argv.length === 0) return undefined;
  if (argv.length !== 2 || argv[0] !== "--port") {
    throw new Error("ui 只支持 --port <port>。");
  }
  const port = Number.parseInt(argv[1]!, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("port 必须是 1-65535 的整数。");
  }
  return port;
}

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${renderError(error)}\n`);
    process.exitCode = 1;
  });
