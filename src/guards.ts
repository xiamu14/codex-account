import type { AccountMeta, AccountQuota, AccountsState, AutoQuotaState, LimitStatus } from './types.ts';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === 'string';
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isNullableString(value: unknown): value is string | null {
  return value === null || isString(value);
}

export function isLimitStatus(value: unknown): value is LimitStatus {
  if (!isRecord(value)) return false;
  return (
    (value.percentLeft === null || isNumber(value.percentLeft)) &&
    isNullableString(value.resetsAt) &&
    isNullableString(value.rawReset)
  );
}

export function isAccountMeta(value: unknown): value is AccountMeta {
  if (!isRecord(value)) return false;
  return (
    isString(value.alias) &&
    isNullableString(value.email) &&
    isNullableString(value.planType) &&
    isNullableString(value.subscriptionExpiresAt) &&
    isString(value.createdAt) &&
    isString(value.updatedAt)
  );
}

export function isAccountQuota(value: unknown): value is AccountQuota {
  if (!isRecord(value)) return false;
  return (
    (value.fiveHour === null || isLimitStatus(value.fiveHour)) &&
    (value.weekly === null || isLimitStatus(value.weekly)) &&
    isString(value.updatedAt)
  );
}

export function isAccountsState(value: unknown): value is AccountsState {
  if (!isRecord(value)) return false;
  if (value.version !== 1) return false;
  if (!Array.isArray(value.accounts)) return false;
  for (const account of value.accounts) {
    if (!isRecord(account) || !isString(account.alias) || !isString(account.createdAt)) {
      return false;
    }
  }
  return isNullableString(value.activeAccount) && isString(value.updatedAt);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isString);
}

export function isNumberRecord(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isNumber);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

export function isAutoQuotaState(value: unknown): value is AutoQuotaState {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    typeof value.enabled === 'boolean' &&
    isNumber(value.intervalMinutes) &&
    isNullableString(value.lastTickAt) &&
    isNullableString(value.nextCheckAt) &&
    isNullableString(value.lastQuotaFetchAt) &&
    isNullableString(value.lastCallAt) &&
    isStringArray(value.lastSuccessAliases) &&
    isStringRecord(value.lastFailureByAlias) &&
    isNumberRecord(value.consecutiveFailureCountByAlias) &&
    isStringArray(value.lastQuotaFetchAliases) &&
    isStringRecord(value.handledFiveHourResets) &&
    isNullableString(value.lastWakeAt) &&
    isNumber(value.lastMissedCheckCount) &&
    isString(value.updatedAt)
  );
}
