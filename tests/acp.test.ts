import { describe, expect, test } from 'bun:test';
import { parseAccountInfo, parseQuota, parseResetCredits } from '../src/acp.ts';

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

  test('parses nested subscription expiry variants', () => {
    const account = parseAccountInfo({
      account: {
        email: 'user@example.com',
        plan: 'plus',
        subscription: {
          current_period_end: 1780272000
        }
      }
    });

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

  test('classifies generic windows by duration instead of position', () => {
    const quota = parseQuota({
      rateLimits: {
        primary: {
          usedPercent: 0,
          windowDurationMins: 10080,
          resetsAt: 1784530219
        }
      }
    });

    expect(quota.fiveHour).toBeNull();
    expect(quota.weekly?.percentLeft).toBe(100);
    expect(quota.weekly?.windowDurationMins).toBe(10080);
  });

  test('maps CLI reset credits to the web payload', () => {
    expect(parseResetCredits({
      rateLimitResetCredits: {
        availableCount: 1,
        credits: [{ status: 'available', grantedAt: 1780272000, expiresAt: null }],
      },
    })).toEqual({
      available_count: 1,
      credits: [{
        status: 'available',
        title: '',
        granted_at: '2026-06-01T00:00:00.000Z',
        expires_at: '',
      }],
    });
    expect(parseResetCredits({
      rateLimitResetCredits: { availableCount: 2, credits: null },
    })).toEqual({ available_count: 2, credits: [] });
    expect(() => parseResetCredits({ rateLimitResetCredits: null })).toThrow(
      'Codex CLI 未提供重置额度数据。',
    );
  });
});
