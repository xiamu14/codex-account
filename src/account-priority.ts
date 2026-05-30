import type { AccountQuota, AccountSummary, LimitStatus } from "./types.ts";

export type LimitWindowKind = "short" | "daily" | "weekly" | "unknown";

export type AccountUsageStatus = "usable" | "blocked" | "unknown";

export type AccountUsagePriority = {
  rank: number | null;
  status: AccountUsageStatus;
  label: string;
  reason: string;
  nextRefillAt: string | null;
  availableAt: string | null;
  primaryWindow: LimitWindowKind;
  secondaryWindow: LimitWindowKind;
};

type RankedAccount = {
  account: AccountSummary;
  index: number;
  priority: AccountUsagePriority;
  sortKey: SortKey;
};

type SortKey = {
  group: number;
  nextRefillMs: number;
  availableMs: number;
  primaryLeft: number;
  secondaryLeft: number;
  index: number;
};

const UNKNOWN_TIME = Number.MAX_SAFE_INTEGER;

export function sortAccountsByUsagePriority(
  accounts: AccountSummary[],
): AccountSummary[] {
  return rankAccountsByUsagePriority(accounts).map((item) => item.account);
}

export function getAccountUsagePriorityByAlias(
  accounts: AccountSummary[],
): Map<string, AccountUsagePriority> {
  const map = new Map<string, AccountUsagePriority>();
  for (const item of rankAccountsByUsagePriority(accounts)) {
    map.set(item.account.alias, item.priority);
  }
  return map;
}

export function getRecommendedNextAlias(
  accounts: AccountSummary[],
): string | null {
  const ranked = rankAccountsByUsagePriority(accounts).filter(
    (item) => !item.account.isActive && item.priority.status === "usable",
  );
  return ranked[0]?.account.alias ?? null;
}

export function describePrimaryLimit(
  quota: AccountQuota | null,
  planType: string | null = null,
): string {
  if (isSubscriptionPlan(planType)) return "5h limit";
  const window = inferLimitWindow(quota?.fiveHour ?? null, quota?.updatedAt ?? null);
  if (window === "short") return "short limit";
  if (window === "daily") return "daily limit";
  if (window === "weekly") return "weekly-like limit";
  return "primary limit";
}

export function isSubscriptionPlan(planType: string | null): boolean {
  if (planType === null) return false;
  return ["plus", "pro", "team", "enterprise", "business"].includes(
    planType.toLowerCase(),
  );
}

export function inferLimitWindow(
  limit: LimitStatus | null,
  updatedAt: string | null,
): LimitWindowKind {
  const reset = parseDate(limit?.resetsAt ?? null);
  const updated = parseDate(updatedAt);
  if (reset === null || updated === null) return "unknown";
  const hours = (reset.getTime() - updated.getTime()) / 3_600_000;
  if (!Number.isFinite(hours) || hours <= 0) return "unknown";
  if (hours <= 6) return "short";
  if (hours <= 30) return "daily";
  return "weekly";
}

function rankAccountsByUsagePriority(accounts: AccountSummary[]): RankedAccount[] {
  const ranked = accounts.map((account, index) => {
    const priority = resolveUsagePriority(account);
    return {
      account,
      index,
      priority,
      sortKey: buildSortKey(account, index, priority),
    };
  });

  ranked.sort(compareRankedAccounts);

  let rank = 1;
  for (const item of ranked) {
    item.priority = {
      ...item.priority,
      rank: item.priority.status === "usable" ? rank++ : null,
      label:
        item.priority.status === "usable"
          ? `#${rank - 1}`
          : item.priority.label,
    };
  }
  return ranked;
}

function resolveUsagePriority(account: AccountSummary): AccountUsagePriority {
  const quota = account.quota;
  const primary = quota?.fiveHour ?? null;
  const secondary = quota?.weekly ?? null;
  const primaryWindow = inferLimitWindow(primary, quota?.updatedAt ?? null);
  const secondaryWindow = inferLimitWindow(secondary, quota?.updatedAt ?? null);

  if (account.tokenStatus === "invalid") {
    return unavailable("blocked", "invalid token", primaryWindow, secondaryWindow);
  }
  if (!account.hasAuth) {
    return unavailable("unknown", "missing auth", primaryWindow, secondaryWindow);
  }
  if (quota === null || primary === null || primary.percentLeft === null) {
    return unavailable("unknown", "quota unknown", primaryWindow, secondaryWindow);
  }

  const blockingResets: Date[] = [];
  if (primary.percentLeft <= 0) {
    const reset = parseDate(primary.resetsAt);
    if (reset !== null) blockingResets.push(reset);
  }
  if (secondary?.percentLeft !== null && secondary?.percentLeft !== undefined && secondary.percentLeft <= 0) {
    const reset = parseDate(secondary.resetsAt);
    if (reset !== null) blockingResets.push(reset);
  }

  if (primary.percentLeft <= 0 || (secondary?.percentLeft !== null && secondary?.percentLeft !== undefined && secondary.percentLeft <= 0)) {
    const availableAt = blockingResets.length === 0
      ? null
      : new Date(Math.max(...blockingResets.map((date) => date.getTime()))).toISOString();
    return {
      rank: null,
      status: "blocked",
      label: "blocked",
      reason: primary.percentLeft <= 0 ? "primary empty" : "weekly empty",
      nextRefillAt: null,
      availableAt,
      primaryWindow,
      secondaryWindow,
    };
  }

  const nextRefillAt = earliestDate([
    primary.percentLeft > 0 ? parseDate(primary.resetsAt) : null,
    secondary !== null && secondary.percentLeft !== null && secondary.percentLeft > 0
      ? parseDate(secondary.resetsAt)
      : null,
  ]);

  return {
    rank: null,
    status: "usable",
    label: "",
    reason: nextRefillAt === null ? "usable, reset unknown" : "usable",
    nextRefillAt: nextRefillAt?.toISOString() ?? null,
    availableAt: null,
    primaryWindow,
    secondaryWindow,
  };
}

function unavailable(
  status: "blocked" | "unknown",
  reason: string,
  primaryWindow: LimitWindowKind,
  secondaryWindow: LimitWindowKind,
): AccountUsagePriority {
  return {
    rank: null,
    status,
    label: status,
    reason,
    nextRefillAt: null,
    availableAt: null,
    primaryWindow,
    secondaryWindow,
  };
}

function buildSortKey(
  account: AccountSummary,
  index: number,
  priority: AccountUsagePriority,
): SortKey {
  const primaryLeft = account.quota?.fiveHour?.percentLeft ?? UNKNOWN_TIME;
  const secondaryLeft = account.quota?.weekly?.percentLeft ?? UNKNOWN_TIME;
  return {
    group:
      account.tokenStatus === "invalid"
        ? 3
        : priority.status === "usable"
          ? 0
          : priority.status === "unknown"
            ? 1
            : 2,
    nextRefillMs: dateTime(priority.nextRefillAt),
    availableMs: dateTime(priority.availableAt),
    primaryLeft,
    secondaryLeft,
    index,
  };
}

function compareRankedAccounts(left: RankedAccount, right: RankedAccount): number {
  return (
    left.sortKey.group - right.sortKey.group ||
    left.sortKey.nextRefillMs - right.sortKey.nextRefillMs ||
    left.sortKey.primaryLeft - right.sortKey.primaryLeft ||
    left.sortKey.secondaryLeft - right.sortKey.secondaryLeft ||
    left.sortKey.availableMs - right.sortKey.availableMs ||
    left.sortKey.index - right.sortKey.index
  );
}

function earliestDate(values: Array<Date | null>): Date | null {
  const dates = values.filter((value): value is Date => value !== null);
  if (dates.length === 0) return null;
  return new Date(Math.min(...dates.map((date) => date.getTime())));
}

function dateTime(value: string | null): number {
  const date = parseDate(value);
  return date?.getTime() ?? UNKNOWN_TIME;
}

function parseDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value.trim().length === 0) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
