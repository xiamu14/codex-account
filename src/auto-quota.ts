import { readJsonIfExists, writeJsonAtomic } from "./fs.ts";
import { isAutoQuotaState, isNumberRecord, isRecord, isString, isStringArray, isStringRecord } from "./guards.ts";
import { autoQuotaStatePath } from "./paths.ts";
import type { AccountStore } from "./store.ts";
import type { AutoQuotaState } from "./types.ts";

export const AUTO_QUOTA_MIN_INTERVAL_MINUTES = 5;
export const AUTO_QUOTA_MAX_INTERVAL_MINUTES = 6;

export function createDefaultAutoQuotaState(): AutoQuotaState {
  const now = new Date().toISOString();
  return {
    version: 1,
    enabled: false,
    intervalMinutes: AUTO_QUOTA_MIN_INTERVAL_MINUTES,
    lastTickAt: null,
    nextCheckAt: null,
    lastQuotaFetchAt: null,
    lastCallAt: null,
    lastSuccessAliases: [],
    lastFailureByAlias: {},
    consecutiveFailureCountByAlias: {},
    lastQuotaFetchAliases: [],
    invalidTokenAliases: [],
    handledFiveHourResets: {},
    lastWakeAt: null,
    lastMissedCheckCount: 0,
    updatedAt: now,
  };
}

export async function readAutoQuotaState(appHome: string): Promise<AutoQuotaState> {
  const parsed = await readJsonIfExists(autoQuotaStatePath(appHome));
  if (parsed === null) return createDefaultAutoQuotaState();
  const migrated = migrateAutoQuotaState(parsed);
  if (migrated === null) {
    throw new Error("auto-quota.json 格式不正确。");
  }
  return migrated;
}

export async function writeAutoQuotaState(
  appHome: string,
  state: AutoQuotaState,
): Promise<void> {
  await writeJsonAtomic(autoQuotaStatePath(appHome), {
    ...state,
    updatedAt: new Date().toISOString(),
  });
}

export async function migrateInvalidTokensFromAutoQuota(
  appHome: string,
  store: AccountStore,
): Promise<void> {
  const state = await readAutoQuotaState(appHome);
  const aliases = state.invalidTokenAliases;
  if (aliases.length === 0) return;
  for (const alias of aliases) {
    await store.markTokenInvalid(alias, "token 已失效");
  }
  await writeAutoQuotaState(appHome, {
    ...state,
    invalidTokenAliases: [],
  });
}

function migrateAutoQuotaState(value: unknown): AutoQuotaState | null {
  if (isAutoQuotaState(value)) {
    return normalizeInvalidTokenState(value);
  }
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.enabled !== "boolean") return null;
  if (typeof value.intervalMinutes !== "number" || !Number.isFinite(value.intervalMinutes)) return null;
  if (value.lastTickAt !== null && !isString(value.lastTickAt)) return null;
  if (value.nextCheckAt !== undefined && value.nextCheckAt !== null && !isString(value.nextCheckAt)) return null;
  if (value.lastQuotaFetchAt !== undefined && value.lastQuotaFetchAt !== null && !isString(value.lastQuotaFetchAt)) return null;
  if (value.lastCallAt !== null && !isString(value.lastCallAt)) return null;
  if (!isStringArray(value.lastSuccessAliases)) return null;
  if (!isStringRecord(value.lastFailureByAlias)) return null;
  if (!isStringArray(value.lastQuotaFetchAliases)) return null;
  if (value.invalidTokenAliases !== undefined && !isStringArray(value.invalidTokenAliases)) return null;
  if (!isStringRecord(value.handledFiveHourResets)) return null;
  if (value.lastWakeAt !== undefined && value.lastWakeAt !== null && !isString(value.lastWakeAt)) return null;
  if (
    value.lastMissedCheckCount !== undefined &&
    (typeof value.lastMissedCheckCount !== "number" || !Number.isFinite(value.lastMissedCheckCount))
  ) return null;
  if (!isString(value.updatedAt)) return null;

  return normalizeInvalidTokenState({
    version: 1,
    enabled: value.enabled,
    intervalMinutes: value.intervalMinutes,
    lastTickAt: value.lastTickAt,
    nextCheckAt: value.nextCheckAt === undefined ? null : value.nextCheckAt,
    lastQuotaFetchAt: value.lastQuotaFetchAt === undefined ? null : value.lastQuotaFetchAt,
    lastCallAt: value.lastCallAt,
    lastSuccessAliases: value.lastSuccessAliases,
    lastFailureByAlias: value.lastFailureByAlias,
    consecutiveFailureCountByAlias: isNumberRecord(value.consecutiveFailureCountByAlias)
      ? value.consecutiveFailureCountByAlias
      : {},
    lastQuotaFetchAliases: value.lastQuotaFetchAliases,
    invalidTokenAliases: value.invalidTokenAliases === undefined ? [] : value.invalidTokenAliases,
    handledFiveHourResets: value.handledFiveHourResets,
    lastWakeAt: value.lastWakeAt === undefined ? null : value.lastWakeAt,
    lastMissedCheckCount: value.lastMissedCheckCount === undefined ? 0 : value.lastMissedCheckCount,
    updatedAt: value.updatedAt,
  });
}

function normalizeInvalidTokenState(state: AutoQuotaState): AutoQuotaState {
  const invalidTokenAliases = new Set(state.invalidTokenAliases);
  const lastFailureByAlias = { ...state.lastFailureByAlias };
  const consecutiveFailureCountByAlias = {
    ...state.consecutiveFailureCountByAlias,
  };
  for (const [alias, reason] of Object.entries(state.lastFailureByAlias)) {
    if (!isInvalidTokenReason(reason)) continue;
    invalidTokenAliases.add(alias);
    delete lastFailureByAlias[alias];
    delete consecutiveFailureCountByAlias[alias];
  }
  return {
    ...state,
    lastFailureByAlias,
    consecutiveFailureCountByAlias,
    invalidTokenAliases: [...invalidTokenAliases],
  };
}

function isInvalidTokenReason(reason: string): boolean {
  return (
    reason.includes("token_invalidated") ||
    reason.includes("401 Unauthorized") ||
    reason.includes("token 已失效") ||
    reason.includes("invalid token")
  );
}
