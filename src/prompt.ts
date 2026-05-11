import { createInterface } from 'node:readline/promises';

export async function confirm(message: string, defaultValue = false): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultValue ? 'Y/n' : 'y/N';
    const answer = (await rl.question(`${message} (${suffix}) `)).trim().toLowerCase();
    if (answer === '') return defaultValue;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
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

  process.stdout.write(`请选择要${action}的账号：\n`);
  aliases.forEach((alias, index) => {
    process.stdout.write(`  ${index + 1}. ${alias}\n`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('输入序号：')).trim();
    const index = Number.parseInt(answer, 10);
    if (!Number.isInteger(index) || index < 1 || index > aliases.length) {
      throw new Error('选择无效。');
    }
    return aliases[index - 1]!;
  } finally {
    rl.close();
  }
}
