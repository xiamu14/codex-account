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

  test('does not downgrade an account from an expired auth JWT claim', async () => {
    const appHome = await tempHome();
    const authPath = path.join(appHome, 'auth.json');
    await writeFile(authPath, makeAuthJsonWithJwt({
      email: 'user@example.com',
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'plus',
        chatgpt_subscription_active_until: '2026-05-15T08:58:28+00:00',
      },
    }), 'utf8');
    const store = new AccountStore(appHome);

    await store.createAccount('user@example.com', authPath, {
      email: 'user@example.com',
      planType: 'plus',
      subscriptionExpiresAt: '2026-05-15T08:58:28.000Z'
    });

    const summaries = await store.listSummaries();

    expect(summaries[0]?.meta?.planType).toBe('plus');
    expect(summaries[0]?.meta?.subscriptionExpiresAt).toBe('2026-05-15T08:58:28.000Z');
    expect((await store.readMeta('user@example.com'))?.planType).toBe('plus');
  });

  test('does not promote a free account from an expired auth JWT claim without weekly quota', async () => {
    const appHome = await tempHome();
    const authPath = path.join(appHome, 'auth.json');
    await writeFile(authPath, makeAuthJsonWithJwt({
      email: 'user@example.com',
      'https://api.openai.com/auth': {
        chatgpt_plan_type: 'plus',
        chatgpt_subscription_active_until: '2026-05-15T08:58:28+00:00',
      },
    }), 'utf8');
    const store = new AccountStore(appHome);

    await store.createAccount('user@example.com', authPath, {
      email: 'user@example.com',
      planType: 'free',
      subscriptionExpiresAt: null
    });

    const summaries = await store.listSummaries();

    expect(summaries[0]?.meta?.planType).toBe('free');
    expect(summaries[0]?.meta?.subscriptionExpiresAt).toBeNull();
  });

});

function makeAuthJsonWithJwt(payload: unknown): string {
  return JSON.stringify({
    tokens: {
      id_token: [
        encodeBase64Url({ alg: 'none', typ: 'JWT' }),
        encodeBase64Url(payload),
        '',
      ].join('.'),
    },
  });
}

function encodeBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
