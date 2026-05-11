import { createInterface } from 'node:readline/promises';
import { isCancel } from '@clack/core';
import { cancel, confirm as clackConfirm, select } from '@clack/prompts';

export async function confirm(message: string, defaultValue = false): Promise<boolean> {
  const value = await clackConfirm({
    message,
    initialValue: defaultValue
  });
  return unwrapPrompt(value);
}

export async function waitForEnter(message: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(`${message}\n按 Enter 继续...`);
  } finally {
    rl.close();
  }
}

export async function selectAlias(aliases: string[], action: string): Promise<string> {
  if (aliases.length === 0) {
    throw new Error('没有可选择的账号。');
  }
  if (aliases.length === 1) {
    return aliases[0]!;
  }

  const value = await select({
    message: `请选择要${action}的账号`,
    options: aliases.map((alias) => {
      return {
        value: alias,
        label: alias
      };
    })
  });
  return unwrapPrompt(value);
}

function unwrapPrompt<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('已取消。');
    throw new Error('已取消。');
  }
  return value;
}
