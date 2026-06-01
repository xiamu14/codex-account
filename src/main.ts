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
  exportCommand,
  importCommand,
  listCommand,
  loginCommand,
  quotaCommand,
  refreshCommand,
  saveCommand,
} from "./commands.ts";
import chalk from "chalk";
import { resolveCodexBin } from "./codex.ts";
import { renderError } from "./format.ts";
import {
  installLaunchdServices,
  renderServiceStartMessage,
  startLaunchdServices,
  stopLaunchdServices,
  uninstallLaunchdServices,
} from "./launchd.ts";
import { resolveAppHome, resolveCodexHome } from "./paths.ts";
import { uiCommand } from "./ui.ts";
import type { CommandContext } from "./types.ts";

function usage(): string {
  const groups: Array<{
    title: string;
    rows: Array<[command: string, description: string]>;
  }> = [
    {
      title: "基础",
      rows: [["bun cli --help", "查看帮助"]],
    },
    {
      title: "Web UI 与定时任务",
      rows: [
        ["bun cli install", "安装 Web UI 与定时任务"],
        ["bun cli uninstall", "卸载 Web UI 与定时任务"],
        ["bun cli start", "启动 Web UI 与定时任务"],
        ["bun cli stop", "停止 Web UI 与定时任务"],
        ["bun cli restart", "重启 Web UI 与定时任务"],
      ],
    },
    {
      title: "账号",
      rows: [
        ["bun cli save", "保存当前账号"],
        ["bun cli login", "登录并保存账号"],
        ["bun cli export", "导出账号和 token"],
        ["bun cli import", "导入账号和 token"],
        ["bun cli deactive", "退出当前账号"],
        ["bun cli delete", "删除账号"],
        ["bun cli refresh", "刷新账号 token"],
      ],
    },
    {
      title: "额度",
      rows: [
        ["bun cli call", "刷新 quota 状态"],
        ["bun cli call --select", "选择账号刷新状态"],
        ["bun cli quota", "刷新额度"],
        ["bun cli quota --select", "选择账号刷新额度"],
        ["bun cli quota --stop", "停止自动刷新"],
      ],
    },
  ];
  const rows = groups.flatMap((group) => group.rows);
  const commandWidth = Math.max(...rows.map(([command]) => command.length));
  const lines = [chalk.bold("用法:")];
  for (const group of groups) {
    lines.push("", chalk.blue(`${group.title}:`));
    for (const [command, description] of group.rows) {
      lines.push(
        `  ${chalk.cyan(command.padEnd(commandWidth))}  ${chalk.gray(description)}`,
      );
    }
  }
  return lines.join("\n");
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

  switch (command) {
    case "install":
      if (argv[1] !== undefined) {
        throw new Error("install 不需要参数。");
      }
      {
        const context = await buildContext();
        await installLaunchdServices(context);
      }
      process.stdout.write("后台服务已安装。\n运行 bun cli start 启动服务。\n");
      return 0;
    case "uninstall":
      if (argv[1] !== undefined) {
        throw new Error("uninstall 不需要参数。");
      }
      await uninstallLaunchdServices();
      process.stdout.write("后台服务已卸载。\n");
      return 0;
    case "start":
      if (argv[1] !== undefined) {
        throw new Error("start 不需要参数。");
      }
      {
        const context = await buildContext();
        await startLaunchdServices(context);
      }
      process.stdout.write(`${renderServiceStartMessage(usage())}\n`);
      return 0;
    case "stop":
      if (argv[1] !== undefined) {
        throw new Error("stop 不需要参数。");
      }
      await stopLaunchdServices();
      process.stdout.write("后台服务已停止。\n");
      return 0;
    case "restart":
      if (argv[1] !== undefined) {
        throw new Error("restart 不需要参数。");
      }
      await stopLaunchdServices();
      const context = await buildContext();
      await startLaunchdServices(context);
      process.stdout.write("后台服务已重启。\n");
      return 0;
    case "save": {
      const context = await buildContext();
      if (argv[1] !== undefined) {
        throw new Error("save 不需要参数。");
      }
      await saveCommand(context);
      return 0;
    }

    case "login": {
      const context = await buildContext();
      if (argv[1] !== undefined) {
        throw new Error("login 不需要参数。");
      }
      await loginCommand(context);
      return 0;
    }
    case "export": {
      if (argv[2] !== undefined) {
        throw new Error("export 最多接收一个导出文件路径。");
      }
      const context = await buildContext();
      await exportCommand(context, argv[1]);
      return 0;
    }
    case "import": {
      if (argv[2] !== undefined) {
        throw new Error("import 最多接收一个导入文件路径。");
      }
      const context = await buildContext();
      await importCommand(context, argv[1]);
      return 0;
    }
    case "list": {
      const context = await buildContext();
      await listCommand(context);
      return 0;
    }
    case "active": {
      const context = await buildContext();
      await activeCommand(context, argv[1]);
      return 0;
    }
    case "deactive": {
      const context = await buildContext();
      await deactiveCommand(context);
      return 0;
    }
    case "delete": {
      const context = await buildContext();
      await deleteCommand(context, argv[1]);
      return 0;
    }
    case "call":
      if (argv[1] !== undefined && argv[1] !== "--select") {
        throw new Error("call 只支持 --select。");
      }
      if (argv[2] !== undefined) throw new Error("call 只支持一个参数。");
      {
        const context = await buildContext();
        await callCommand(context, { select: argv[1] === "--select" });
      }
      return 0;
    case "quota":
      if (argv[2] !== undefined) {
        throw new Error("quota 只支持一个参数。");
      }
      {
        const context = await buildContext();
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
      }
      return 0;
    case "refresh":
      {
        const context = await buildContext();
        if (argv[1] === "--auto") {
          if (argv[2] !== undefined && argv[2] !== "--dryRun") {
            throw new Error("refresh --auto 只支持 --dryRun。");
          }
          if (argv[3] !== undefined) {
            throw new Error("refresh --auto 只支持 --dryRun。");
          }
          await refreshCommand(context, {
            auto: true,
            dryRun: argv[2] === "--dryRun",
          });
          return 0;
        }
        if (argv[2] !== undefined) throw new Error("refresh 最多接收一个账号。");
        await refreshCommand(context, argv[1]);
      }
      return 0;

    case "ui": {
      const context = await buildContext();
      await uiCommand(context, parseUiOptions(argv.slice(1)));
      return 0;
    }
    default:
      throw new Error(`未知命令：${command}\n${usage()}`);
  }
}

function parseUiOptions(argv: string[]): { serve?: boolean } {
  if (argv.length === 0) return {};
  if (argv.length === 1 && argv[0] === "--serve") {
    return { serve: true };
  }
  throw new Error("ui 不接收参数。");
}

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${renderError(error)}\n`);
    process.exitCode = 1;
  });
