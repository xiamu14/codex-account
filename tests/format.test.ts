import { describe, expect, test } from 'bun:test';
import { formatAccountDisplayName, formatCompactAccountDisplayName } from '../src/account-display.ts';
import { formatDateTime, renderList, sortAccountsForList } from '../src/format.ts';
import type { AccountSummary } from '../src/types.ts';

describe('account display names', () => {
  test('hides email suffixes and trims a trailing dot', () => {
    expect(formatAccountDisplayName('martinlindafgxpi2888.@gmail.com')).toBe('martinlindafgxpi2888');
    expect(formatAccountDisplayName('same@example.com')).toBe('same');
    expect(formatCompactAccountDisplayName('averyveryverylongname@example.com')).toBe('averyveryverylo...');
  });
});

describe('formatDateTime', () => {
  test('formats iso time without T or timezone suffix', () => {
    const rendered = formatDateTime('2026-05-11T04:39:22.000Z');
    expect(rendered).not.toContain('T');
    expect(rendered).not.toContain('Z');
    expect(rendered).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('keeps unknown for missing values', () => {
    expect(formatDateTime(null)).toBe('unknown');
  });
});

describe('renderList', () => {
  test('hides duplicate email row and email suffix when alias is the email', () => {
    const rendered = renderList([{
      alias: 'same@example.com',
      isActive: false,
      hasAuth: true,
      tokenStatus: 'valid',
      tokenInvalidatedAt: null,
      tokenInvalidReason: null,
      meta: {
        alias: 'same@example.com',
        email: 'same@example.com',
        planType: 'plus',
        subscriptionExpiresAt: null,
        tokenStatus: 'valid',
        tokenInvalidatedAt: null,
        tokenInvalidReason: null,
        createdAt: '2026-05-11T00:00:00.000Z',
        updatedAt: '2026-05-11T00:00:00.000Z'
      },
      quota: null
    }]);

    expect(rendered).not.toContain('email');
    expect(rendered).toContain('same');
    expect(rendered).not.toContain('same@example.com');
  });

  test('shows unknown subscription when expiry date is not set', () => {
    const rendered = renderList([{
      alias: 'same@example.com',
      isActive: false,
      hasAuth: true,
      tokenStatus: 'valid',
      tokenInvalidatedAt: null,
      tokenInvalidReason: null,
      meta: {
        alias: 'same@example.com',
        email: 'same@example.com',
        planType: 'plus',
        subscriptionExpiresAt: null,
        tokenStatus: 'valid',
        tokenInvalidatedAt: null,
        tokenInvalidReason: null,
        createdAt: '2026-05-11T00:00:00.000Z',
        updatedAt: '2026-05-11T00:00:00.000Z'
      },
      quota: null
    }]);

    expect(rendered).toContain('subscription');
    expect(rendered).toContain('unknown');
  });

  test('shows free plan when account is not subscribed', () => {
    const rendered = renderList([{
      alias: 'same@example.com',
      isActive: false,
      hasAuth: true,
      tokenStatus: 'valid',
      tokenInvalidatedAt: null,
      tokenInvalidReason: null,
      meta: {
        alias: 'same@example.com',
        email: 'same@example.com',
        planType: null,
        subscriptionExpiresAt: null,
        tokenStatus: 'valid',
        tokenInvalidatedAt: null,
        tokenInvalidReason: null,
        createdAt: '2026-05-11T00:00:00.000Z',
        updatedAt: '2026-05-11T00:00:00.000Z'
      },
      quota: null
    }]);

    expect(rendered).toContain('plan          free');
  });

  test('shows subscription row when an expiry date is available', () => {
    const rendered = renderList([{
      alias: 'same@example.com',
      isActive: false,
      hasAuth: true,
      tokenStatus: 'valid',
      tokenInvalidatedAt: null,
      tokenInvalidReason: null,
      meta: {
        alias: 'same@example.com',
        email: 'same@example.com',
        planType: 'plus',
        subscriptionExpiresAt: '2026-06-01T00:00:00.000Z',
        tokenStatus: 'valid',
        tokenInvalidatedAt: null,
        tokenInvalidReason: null,
        createdAt: '2026-05-11T00:00:00.000Z',
        updatedAt: '2026-05-11T00:00:00.000Z'
      },
      quota: null
    }]);

    expect(rendered).toContain('subscription');
    expect(rendered).toContain('2026-06-01');
  });

  test('highlights low quota states', () => {
    const rendered = renderList([{
      alias: 'low@example.com',
      isActive: true,
      hasAuth: true,
      tokenStatus: 'valid',
      tokenInvalidatedAt: null,
      tokenInvalidReason: null,
      meta: {
        alias: 'low@example.com',
        email: 'low@example.com',
        planType: 'plus',
        subscriptionExpiresAt: null,
        tokenStatus: 'valid',
        tokenInvalidatedAt: null,
        tokenInvalidReason: null,
        createdAt: '2026-05-11T00:00:00.000Z',
        updatedAt: '2026-05-11T00:00:00.000Z'
      },
      quota: {
        fiveHour: {
          percentLeft: 8,
          resetsAt: '2026-05-11T04:39:22.000Z',
          rawReset: null
        },
        weekly: {
          percentLeft: 24,
          resetsAt: '2026-05-17T15:36:16.000Z',
          rawReset: null
        },
        updatedAt: '2026-05-11T00:00:00.000Z'
      }
    }]);

    expect(rendered).toContain('LOW');
    expect(rendered).toContain('8% left');
    expect(rendered).toContain('24% left');
  });
});

describe('sortAccountsForList', () => {
  test('orders usable accounts by fastest refill, then lower remaining quota', () => {
    const accounts: AccountSummary[] = [
      makeSummary('unknown'),
      makeSummary('refills-later', false, 10, 90, '2026-06-10T00:00:00.000Z', '2026-05-11T06:00:00.000Z'),
      makeSummary('refills-sooner-high', false, 80, 10, '2026-06-20T00:00:00.000Z', '2026-05-11T02:00:00.000Z'),
      makeSummary('refills-sooner-low', true, 20, 20, '2026-07-01T00:00:00.000Z', '2026-05-11T02:00:00.000Z'),
      makeSummary('zero-primary', false, 0, 20, '2026-05-17T00:00:00.000Z', '2026-05-11T01:00:00.000Z')
    ];

    expect(sortAccountsForList(accounts).map((account) => account.alias)).toEqual([
      'refills-sooner-low',
      'refills-sooner-high',
      'refills-later',
      'unknown',
      'zero-primary'
    ]);
  });

  test('moves blocked accounts behind usable accounts', () => {
    const accounts: AccountSummary[] = [
      makeSummary('zero-weekly-active', true, 99, 0, '2026-05-17T00:00:00.000Z', '2026-05-11T02:00:00.000Z'),
      makeSummary('normal-high', false, 95, 50, '2026-06-10T00:00:00.000Z', '2026-05-11T03:00:00.000Z'),
      makeSummary('normal-mid', false, 20, 20, '2026-06-01T00:00:00.000Z', '2026-05-11T02:00:00.000Z'),
      makeSummary('zero-five-hour', false, 0, 100, '2026-05-16T00:00:00.000Z', '2026-05-11T01:00:00.000Z')
    ];

    expect(sortAccountsForList(accounts).map((account) => account.alias)).toEqual([
      'normal-mid',
      'normal-high',
      'zero-five-hour',
      'zero-weekly-active'
    ]);
  });
});

function makeSummary(
  alias: string,
  isActive = false,
  fiveHour: number | null = null,
  weekly: number | null = null,
  subscriptionExpiresAt: string | null = null,
  fiveHourResetsAt: string | null = null
): AccountSummary {
  return {
    alias,
    isActive,
    hasAuth: true,
    tokenStatus: 'valid',
    tokenInvalidatedAt: null,
    tokenInvalidReason: null,
    meta: {
      alias,
      email: alias,
      planType: 'plus',
      subscriptionExpiresAt,
      tokenStatus: 'valid',
      tokenInvalidatedAt: null,
      tokenInvalidReason: null,
      createdAt: '2026-05-11T00:00:00.000Z',
      updatedAt: '2026-05-11T00:00:00.000Z'
    },
    quota: fiveHour === null && weekly === null
      ? null
      : {
          fiveHour: fiveHour === null
            ? null
            : { percentLeft: fiveHour, resetsAt: fiveHourResetsAt, rawReset: null },
          weekly: weekly === null ? null : { percentLeft: weekly, resetsAt: null, rawReset: null },
          updatedAt: '2026-05-11T00:00:00.000Z'
        }
  };
}
