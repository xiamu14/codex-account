import { readJsonIfExists } from "./fs.ts";
import { isNumber, isRecord, isString } from "./guards.ts";
import type { AcpAccountInfo } from "./types.ts";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

export async function readAuthAccountInfo(
  authPath: string,
): Promise<AcpAccountInfo | null> {
  const auth = await readJsonIfExists(authPath);
  return parseAuthAccountInfo(auth);
}

export function parseAuthAccountInfo(value: unknown): AcpAccountInfo | null {
  if (!isRecord(value)) return null;
  const token = pickIdToken(value);
  if (token === null) return null;
  const payload = decodeJwtPayload(token);
  if (payload === null) return null;

  const auth = isRecord(payload[OPENAI_AUTH_CLAIM])
    ? payload[OPENAI_AUTH_CLAIM]
    : {};
  const subscriptionExpiresAt =
    pickDate(auth, [
      "chatgpt_subscription_active_until",
      "subscriptionExpiresAt",
      "expiresAt",
      "currentPeriodEnd",
      "current_period_end",
    ]) ??
    pickDate(payload, [
      "subscriptionExpiresAt",
      "expiresAt",
      "currentPeriodEnd",
      "current_period_end",
    ]);
  const planType =
    pickString(auth, [
      "chatgpt_plan_type",
      "planType",
      "plan_type",
      "subscriptionPlan",
    ]) ?? pickString(payload, ["planType", "plan_type", "plan"]);
  if (isExpiredSubscription(subscriptionExpiresAt)) {
    return {
      email: pickString(payload, ["email"]),
      planType: "free",
      subscriptionExpiresAt: null,
    };
  }
  return {
    email: pickString(payload, ["email"]),
    planType,
    subscriptionExpiresAt,
  };
}

export function mergeAccountInfo(
  account: AcpAccountInfo,
  authAccount: AcpAccountInfo | null,
): AcpAccountInfo {
  if (authAccount === null) return account;
  return {
    email: account.email ?? authAccount.email,
    planType: authAccount.planType ?? account.planType,
    subscriptionExpiresAt:
      authAccount.subscriptionExpiresAt ?? account.subscriptionExpiresAt,
  };
}

function pickIdToken(value: Record<string, unknown>): string | null {
  if (isRecord(value.tokens) && isString(value.tokens.id_token)) {
    return value.tokens.id_token;
  }
  if (isString(value.id_token)) return value.id_token;
  return null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  const payload = parts[1];
  if (payload === undefined) return null;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (isString(value) && value.trim().length > 0) return value;
  }
  return null;
}

function pickDate(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (isString(value) && value.trim().length > 0) {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? value : date.toISOString();
    }
    if (isNumber(value)) {
      const date = value > 1_000_000_000_000
        ? new Date(value)
        : new Date(value * 1000);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
  }
  return null;
}

function isExpiredSubscription(value: string | null): boolean {
  if (value === null) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.getTime() <= Date.now();
}
