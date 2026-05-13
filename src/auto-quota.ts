import { readJsonIfExists, writeJsonAtomic } from "./fs.ts";
import { isAutoQuotaState, isNumberRecord, isRecord, isString, isStringArray, isStringRecord } from "./guards.ts";
import { autoQuotaStatePath } from "./paths.ts";
import type { AutoQuotaState } from "./types.ts";

export const AUTO_QUOTA_INTERVAL_MINUTES = 30;

export function createDefaultAutoQuotaState(): AutoQuotaState {
  const now = new Date().toISOString();
  return {
    version: 1,
    enabled: false,
    intervalMinutes: AUTO_QUOTA_INTERVAL_MINUTES,
    lastTickAt: null,
    lastCallAt: null,
    lastSuccessAliases: [],
    lastFailureByAlias: {},
    consecutiveFailureCountByAlias: {},
    lastQuotaFetchAliases: [],
    handledFiveHourResets: {},
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

function migrateAutoQuotaState(value: unknown): AutoQuotaState | null {
  if (isAutoQuotaState(value)) return value;
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.enabled !== "boolean") return null;
  if (typeof value.intervalMinutes !== "number" || !Number.isFinite(value.intervalMinutes)) return null;
  if (value.lastTickAt !== null && !isString(value.lastTickAt)) return null;
  if (value.lastCallAt !== null && !isString(value.lastCallAt)) return null;
  if (!isStringArray(value.lastSuccessAliases)) return null;
  if (!isStringRecord(value.lastFailureByAlias)) return null;
  if (!isStringArray(value.lastQuotaFetchAliases)) return null;
  if (!isStringRecord(value.handledFiveHourResets)) return null;
  if (!isString(value.updatedAt)) return null;

  return {
    version: 1,
    enabled: value.enabled,
    intervalMinutes: value.intervalMinutes,
    lastTickAt: value.lastTickAt,
    lastCallAt: value.lastCallAt,
    lastSuccessAliases: value.lastSuccessAliases,
    lastFailureByAlias: value.lastFailureByAlias,
    consecutiveFailureCountByAlias: isNumberRecord(value.consecutiveFailureCountByAlias)
      ? value.consecutiveFailureCountByAlias
      : {},
    lastQuotaFetchAliases: value.lastQuotaFetchAliases,
    handledFiveHourResets: value.handledFiveHourResets,
    updatedAt: value.updatedAt,
  };
}
