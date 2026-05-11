import { describe, expect, test } from 'bun:test';
import { parseAccountInfo, parseQuota } from '../src/acp.ts';

describe('ACP parsers', () => {
  test('parses account/read response payload', () => {
    const account = parseAccountInfo({
      account: {
        email: 'user@example.com',
        planType: 'plus',
        subscriptionExpiresAt: '2026-06-01T00:00:00.000Z'
      }
    });

    expect(account.email).toBe('user@example.com');
    expect(account.planType).toBe('plus');
    expect(account.subscriptionExpiresAt).toBe('2026-06-01T00:00:00.000Z');
  });

  test('parses rate limit payload variants', () => {
    const quota = parseQuota({
      rateLimits: {
        fiveHour: {
          percentLeft: 96,
          resetText: '19:06'
        },
        weekly: {
          remainingPercent: '60',
          displayReset: '09:41 on 13 May'
        }
      }
    });

    expect(quota.fiveHour?.percentLeft).toBe(96);
    expect(quota.fiveHour?.rawReset).toBe('19:06');
    expect(quota.weekly?.percentLeft).toBe(60);
    expect(quota.weekly?.rawReset).toBe('09:41 on 13 May');
  });
});
