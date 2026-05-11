#!/usr/bin/env bun
import { addCommand, activeCommand, deactiveCommand, deleteCommand, listCommand, loginCommand, refreshCommand, subCommand, updateCommand } from './commands.ts';
import { resolveCodexBin } from './codex.ts';
import { renderError } from './format.ts';
import { resolveAppHome, resolveCodexHome } from './paths.ts';
import type { CommandContext } from './types.ts';

function usage(): string {
  return [
    '用法:',
    '  cxa new <alias>                 或 cxa -n <alias>',
    '  cxa login',
    '  cxa list                        或 cxa -l',
    '  cxa active [alias]              或 cxa -a [alias]',
    '  cxa deactive                    或 cxa -d',
    '  cxa delete [alias]',
    '  cxa update                      或 cxa -u',
    '  cxa refresh [alias]             或 cxa -r [alias]',
    '  cxa subsciption <YYYY-MM-DD> [alias]  或 cxa -s <YYYY-MM-DD> [alias]'
  ].join('\n');
}

async function buildContext(): Promise<CommandContext> {
  return {
    appHome: resolveAppHome(),
    codexHome: resolveCodexHome(),
    codexBin: await resolveCodexBin(),
    cwd: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin
  };
}

async function run(argv: string[]): Promise<number> {
  const command = argv[0];
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const context = await buildContext();
  switch (command) {
    case 'new':
    case '-n': {
      const alias = argv[1];
      if (alias === undefined) throw new Error('请提供账号别名。');
      await addCommand(context, alias);
      return 0;
    }
    case 'login':
      await loginCommand(context);
      return 0;
    case 'list':
    case '-l':
      await listCommand(context);
      return 0;
    case 'active':
    case '-a':
      await activeCommand(context, argv[1]);
      return 0;
    case 'deactive':
    case '-d':
      await deactiveCommand(context);
      return 0;
    case 'delete':
      await deleteCommand(context, argv[1]);
      return 0;
    case 'update':
    case '-u':
      await updateCommand(context);
      return 0;
    case 'refresh':
    case '-r':
      if (argv[2] !== undefined) throw new Error("refresh 只接收一个账号别名。");
      await refreshCommand(context, argv[1]);
      return 0;
    case 'subsciption':
    case 'subscription':
    case '-s': {
      const dateText = argv[1];
      if (dateText === undefined) throw new Error('请提供订阅到期日期，例如 cxa subsciption 2026-06-01。');
      await subCommand(context, dateText, argv[2]);
      return 0;
    }
    default:
      throw new Error(`未知命令：${command}\n${usage()}`);
  }
}

run(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  process.stderr.write(`${renderError(error)}\n`);
  process.exitCode = 1;
});
