import { createInterface } from 'node:readline/promises';
import type { Writable } from 'node:stream';
import { isCancel } from '@clack/core';
import { cancel, confirm as clackConfirm, multiselect, select, spinner, text } from '@clack/prompts';
import type { TextOptions } from '@clack/prompts';

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
    await rl.question(`${message}\n按 Enter 继续`);
  } finally {
    rl.close();
  }
}

export async function inputText(
  message: string,
  placeholder?: string,
  validate?: (value: string | undefined) => string | undefined,
): Promise<string> {
  const options: TextOptions = { message };
  if (placeholder !== undefined) options.placeholder = placeholder;
  if (validate !== undefined) options.validate = validate;
  const value = await text(options);
  return unwrapPrompt(value);
}

export async function selectAlias(aliases: string[], action: string): Promise<string> {
  if (aliases.length === 0) {
    throw new Error('没有账号可选。');
  }
  if (aliases.length === 1) {
    return aliases[0]!;
  }

  const value = await select({
    message: `选择要${action}的账号`,
    options: aliases.map((alias) => {
      return {
        value: alias,
        label: alias
      };
    })
  });
  return unwrapPrompt(value);
}

export async function selectAliases(aliases: string[], action: string): Promise<string[]> {
  if (aliases.length === 0) {
    throw new Error('没有账号可选。');
  }

  const value = await multiselect({
    message: `选择要${action}的账号`,
    options: aliases.map((alias) => {
      return {
        value: alias,
        label: alias
      };
    }),
    required: true
  });
  return unwrapPrompt(value);
}

export function createSpinner(output?: Writable) {
  return output === undefined ? spinner() : spinner({ output });
}

function unwrapPrompt<T>(value: T | symbol): T {
  if (isCancel(value)) {
    cancel('已取消。');
    throw new Error('已取消。');
  }
  return value;
}
