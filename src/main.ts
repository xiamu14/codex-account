#!/usr/bin/env bun
import {
  activeCommand,
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
import type { CommandContext } from "./types.ts";

function usage(): string {
  const rows: Array<[command: string, description: string]> = [
    ["bun cli --help", "查看帮助"],
    ["cxa save", "保存当前已登录账号"],
    ["cxa login", "登录新账号并保存到本地"],
    ["cxa list", "查看本地账号和缓存信息"],
    ["cxa active", "激活账号"],
    ["cxa deactive", "退出 Codex 账号"],
    ["cxa delete", "删除本地保存的账号"],
    ["cxa call", "给所有账号发一条极短消息，激活 quota reset"],
    ["cxa call --select", "选择账号并发送极短消息"],
    ["cxa quota", "刷新所有账号的账号信息和额度缓存"],
    ["cxa quota --select", "选择账号并刷新额度缓存"],
    ["cxa refresh", "刷新账号 token"],
    ["cxa subscription", "选择账号并输入订阅到期日"],
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
        throw new Error("save 不接收参数，请按提示输入账号别名。");
      }
      await saveCommand(context);
      return 0;
    }

    case "login":
      if (argv[1] !== undefined) {
        throw new Error("login 不接收参数，请按提示输入账号别名。");
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
        throw new Error("call 不接收账号别名。请使用 cxa call 或 cxa call --select。");
      }
      if (argv[2] !== undefined)
        throw new Error("call 只支持 --select 参数。");
      await callCommand(context, { select: argv[1] === "--select" });
      return 0;
    case "quota":
      if (argv[1] !== undefined && argv[1] !== "--select") {
        throw new Error("quota 不接收账号别名。请使用 cxa quota 或 cxa quota --select。");
      }
      if (argv[2] !== undefined)
        throw new Error("quota 只支持 --select 参数。");
      await quotaCommand(context, { select: argv[1] === "--select" });
      return 0;
    case "refresh":
      if (argv[2] !== undefined)
        throw new Error("refresh 只接收一个账号别名。");
      await refreshCommand(context, argv[1]);
      return 0;

    case "subscription": {
      if (argv[1] !== undefined) {
        throw new Error(
          "subscription 不接收参数，请按提示选择账号并输入订阅到期日期。",
        );
      }
      await subscriptionCommand(context);
      return 0;
    }
    default:
      throw new Error(`未知命令：${command}\n${usage()}`);
  }
}

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${renderError(error)}\n`);
    process.exitCode = 1;
  });
