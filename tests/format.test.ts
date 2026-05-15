import { describe, expect, test } from 'bun:test';
import { formatDateTime, renderList, sortAccountsForList } from '../src/format.ts';
import type { AccountSummary } from '../src/types.ts';

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
  test('hides duplicate email row when alias is the email', () => {
    const rendered = renderList([{
      alias: 'same@example.com',
      isActive: false,
      hasAuth: true,
      meta: {
        alias: 'same@example.com',
        email: 'same@example.com',
        planType: 'plus',
        subscriptionExpiresAt: null,
        createdAt: '2026-05-11T00:00:00.000Z',
        updatedAt: '2026-05-11T00:00:00.000Z'
      },
      quota: null
    }]);

    expect(rendered).not.toContain('email');
    expect(rendered).toContain('same@example.com');
  });

  test('shows unknown subscription when expiry date is not set', () => {
    const rendered = renderList([{
      alias: 'same@example.com',
      isActive: false,
      hasAuth: true,
      meta: {
        alias: 'same@example.com',
        email: 'same@example.com',
        planType: 'plus',
        subscriptionExpiresAt: null,
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
      meta: {
        alias: 'same@example.com',
        email: 'same@example.com',
        planType: null,
        subscriptionExpiresAt: null,
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
      meta: {
        alias: 'same@example.com',
        email: 'same@example.com',
        planType: 'plus',
        subscriptionExpiresAt: '2026-06-01T00:00:00.000Z',
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
      meta: {
        alias: 'low@example.com',
        email: 'low@example.com',
        planType: 'plus',
        subscriptionExpiresAt: null,
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
  test('orders active first, then by 5h limit, then by weekly limit', () => {
    const accounts: AccountSummary[] = [
      makeSummary('unknown'),
      makeSummary('weekly-winner', false, 50, 90),
      makeSummary('five-hour-winner', false, 80, 10),
      makeSummary('active-low', true, 1, 1),
      makeSummary('weekly-loser', false, 50, 20)
    ];

    expect(sortAccountsForList(accounts).map((account) => account.alias)).toEqual([
      'active-low',
      'five-hour-winner',
      'weekly-winner',
      'weekly-loser',
      'unknown'
    ]);
  });
});

function makeSummary(
  alias: string,
  isActive = false,
  fiveHour: number | null = null,
  weekly: number | null = null
): AccountSummary {
  return {
    alias,
    isActive,
    hasAuth: true,
    meta: {
      alias,
      email: alias,
      planType: 'plus',
      subscriptionExpiresAt: null,
      createdAt: '2026-05-11T00:00:00.000Z',
      updatedAt: '2026-05-11T00:00:00.000Z'
    },
    quota: fiveHour === null && weekly === null
      ? null
      : {
          fiveHour: fiveHour === null
            ? null
            : { percentLeft: fiveHour, resetsAt: null, rawReset: null },
          weekly: weekly === null ? null : { percentLeft: weekly, resetsAt: null, rawReset: null },
          updatedAt: '2026-05-11T00:00:00.000Z'
        }
  };
}
