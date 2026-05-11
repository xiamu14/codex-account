import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { addCommand, findSavedAccount, subCommand } from '../src/commands.ts';
import { AccountStore } from '../src/store.ts';
import type { AccountSummary, CommandContext } from '../src/types.ts';

async function makeContext(): Promise<CommandContext> {
  const appHome = await mkdtemp(path.join(tmpdir(), 'cxa-command-'));
  return {
    appHome,
    codexHome: path.join(appHome, 'codex'),
    codexBin: 'codex',
    cwd: appHome,
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin
  };
}

describe('subCommand', () => {
  test('updates subscription expiry for an account', async () => {
    const context = await makeContext();
    const authPath = path.join(context.appHome, 'auth.json');
    await writeFile(authPath, '{"token":"one"}', 'utf8');
    const store = new AccountStore(context.appHome);
    await store.createAccount('user@example.com', authPath, {
      email: 'user@example.com',
      planType: 'plus',
      subscriptionExpiresAt: null
    });

    await subCommand(context, '2026-06-01', 'user@example.com');

    const meta = await store.readMeta('user@example.com');
    expect(meta?.subscriptionExpiresAt).toContain('2026-06-01');
  });

  test('rejects invalid date format', async () => {
    const context = await makeContext();
    await expect(subCommand(context, '2026/06/01', 'user@example.com')).rejects.toThrow('YYYY-MM-DD');
  });
});

describe('addCommand', () => {
  test('only reports when the requested alias is already saved', async () => {
    const output = new CaptureStream();
    const context = await makeContext();
    context.stdout = output as unknown as NodeJS.WriteStream;
    const authPath = path.join(context.appHome, 'auth.json');
    await writeFile(authPath, '{"token":"one"}', 'utf8');
    const store = new AccountStore(context.appHome);
    await store.createAccount('user@example.com', authPath, {
      email: 'user@example.com',
      planType: 'plus',
      subscriptionExpiresAt: null
    });

    await addCommand(context, 'user@example.com');

    expect(output.text).toContain('已保存');
    expect(await store.listSummaries()).toHaveLength(1);
  });
});

describe('findSavedAccount', () => {
  test('matches the current login by saved email or alias', () => {
    const accounts = [
      makeSummary('work', false, 'person@example.com'),
      makeSummary('other@example.com', false, null)
    ];

    expect(findSavedAccount(accounts, {
      email: 'person@example.com',
      planType: 'plus',
      subscriptionExpiresAt: null
    })?.alias).toBe('work');

    expect(findSavedAccount(accounts, {
      email: 'other@example.com',
      planType: 'plus',
      subscriptionExpiresAt: null
    })?.alias).toBe('other@example.com');
  });

  test('falls back to the active account when account email is unavailable', () => {
    const accounts = [
      makeSummary('inactive', false, null),
      makeSummary('active', true, null)
    ];

    expect(findSavedAccount(accounts, {
      email: null,
      planType: null,
      subscriptionExpiresAt: null
    })?.alias).toBe('active');
  });
});

function makeSummary(alias: string, isActive: boolean, email: string | null): AccountSummary {
  return {
    alias,
    isActive,
    hasAuth: true,
    meta: {
      alias,
      email,
      planType: 'plus',
      subscriptionExpiresAt: null,
      createdAt: '2026-05-11T00:00:00.000Z',
      updatedAt: '2026-05-11T00:00:00.000Z'
    },
    quota: null
  };
}

class CaptureStream extends Writable {
  text = '';

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.text += chunk.toString();
    callback();
  }
}
