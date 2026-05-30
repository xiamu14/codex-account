import { describe, expect, test } from "bun:test";
import {
  describePrimaryLimit,
  getRecommendedNextAlias,
  sortAccountsByUsagePriority,
} from "../src/account-priority.ts";
import type { AccountSummary } from "../src/types.ts";

describe("account usage priority", () => {
  test("recommends the inactive usable account with the fastest refill", () => {
    const accounts = [
      makeSummary("active@example.com", true, 5, "2026-05-11T03:00:00.000Z"),
      makeSummary("slow@example.com", false, 1, "2026-05-11T06:00:00.000Z"),
      makeSummary("fast@example.com", false, 90, "2026-05-11T02:00:00.000Z"),
    ];

    expect(getRecommendedNextAlias(accounts)).toBe("fast@example.com");
  });

  test("waits for all blocking limits before treating an account as available", () => {
    const accounts = [
      makeSummary("usable@example.com", false, 10, "2026-05-11T05:00:00.000Z"),
      makeSummary("blocked@example.com", false, 0, "2026-05-11T02:00:00.000Z", 0, "2026-05-17T00:00:00.000Z"),
    ];

    const sorted = sortAccountsByUsagePriority(accounts);
    expect(sorted.map((account) => account.alias)).toEqual([
      "usable@example.com",
      "blocked@example.com",
    ]);
  });

  test("classifies the primary reset window from actual quota times", () => {
    expect(describePrimaryLimit(makeQuota("2026-05-11T05:30:00.000Z"))).toBe(
      "short limit",
    );
    expect(describePrimaryLimit(makeQuota("2026-05-12T00:00:00.000Z"))).toBe(
      "daily limit",
    );
    expect(describePrimaryLimit(makeQuota("2026-05-17T00:00:00.000Z"))).toBe(
      "weekly-like limit",
    );
  });

  test("uses 5h limit label for subscription plans", () => {
    expect(
      describePrimaryLimit(makeQuota("2026-05-11T05:30:00.000Z"), "plus"),
    ).toBe("5h limit");
  });

  test("moves invalid token accounts behind all usable and blocked accounts", () => {
    const invalid = makeSummary("invalid@example.com", true, 95, "2026-05-11T02:00:00.000Z");
    invalid.tokenStatus = "invalid";
    invalid.meta!.tokenStatus = "invalid";
    const accounts = [
      invalid,
      makeSummary("usable@example.com", false, 10, "2026-05-11T05:00:00.000Z"),
      makeSummary("blocked@example.com", false, 0, "2026-05-11T02:00:00.000Z"),
    ];

    expect(sortAccountsByUsagePriority(accounts).map((account) => account.alias)).toEqual([
      "usable@example.com",
      "blocked@example.com",
      "invalid@example.com",
    ]);
    expect(getRecommendedNextAlias(accounts)).toBe("usable@example.com");
  });
});

function makeSummary(
  alias: string,
  isActive: boolean,
  primaryLeft: number,
  primaryReset: string,
  weeklyLeft: number | null = null,
  weeklyReset: string | null = null,
): AccountSummary {
  return {
    alias,
    isActive,
    hasAuth: true,
    tokenStatus: "valid",
    tokenInvalidatedAt: null,
    tokenInvalidReason: null,
    meta: {
      alias,
      email: alias,
      planType: "plus",
      subscriptionExpiresAt: null,
      tokenStatus: "valid",
      tokenInvalidatedAt: null,
      tokenInvalidReason: null,
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T00:00:00.000Z",
    },
    quota: {
      fiveHour: {
        percentLeft: primaryLeft,
        resetsAt: primaryReset,
        rawReset: null,
      },
      weekly:
        weeklyLeft === null
          ? null
          : {
              percentLeft: weeklyLeft,
              resetsAt: weeklyReset,
              rawReset: null,
            },
      updatedAt: "2026-05-11T00:00:00.000Z",
    },
  };
}

function makeQuota(primaryReset: string) {
  return {
    fiveHour: {
      percentLeft: 50,
      resetsAt: primaryReset,
      rawReset: null,
    },
    weekly: null,
    updatedAt: "2026-05-11T00:00:00.000Z",
  };
}
