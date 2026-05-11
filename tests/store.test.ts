import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AccountStore } from '../src/store.ts';

async function tempHome(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), 'cxa-store-'));
}

describe('AccountStore', () => {
  test('creates accounts and rejects duplicate aliases', async () => {
    const appHome = await tempHome();
    const authPath = path.join(appHome, 'auth.json');
    await writeFile(authPath, '{"token":"one"}', 'utf8');
    const store = new AccountStore(appHome);

    await store.createAccount('user@example.com', authPath, {
      email: 'user@example.com',
      planType: 'plus',
      subscriptionExpiresAt: null
    });

    await expect(store.createAccount('user@example.com', authPath, {
      email: 'user@example.com',
      planType: 'plus',
      subscriptionExpiresAt: null
    })).rejects.toThrow('已存在');

    const summaries = await store.listSummaries();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.alias).toBe('user@example.com');
    expect(summaries[0]?.meta?.email).toBe('user@example.com');
  });

  test('does not delete active account', async () => {
    const appHome = await tempHome();
    const authPath = path.join(appHome, 'auth.json');
    await writeFile(authPath, '{"token":"one"}', 'utf8');
    const store = new AccountStore(appHome);

    await store.createAccount('user@example.com', authPath, {
      email: null,
      planType: null,
      subscriptionExpiresAt: null
    });
    await store.setActive('user@example.com');

    await expect(store.deleteAccount('user@example.com')).rejects.toThrow('deactive');
  });
});
