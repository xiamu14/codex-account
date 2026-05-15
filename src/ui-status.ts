import type { AccountQuota } from "./types.ts";

export type UiStatus = {
  accounts: Array<{
    alias: string;
    email: string | null;
    planType: string | null;
    subscriptionExpiresAt: string | null;
    isActive: boolean;
    hasAuth: boolean;
    quota: AccountQuota | null;
    nextRefreshAt: string | null;
    lastQuotaFetchAt: string | null;
    lastCallAt: string | null;
    lastCallStatus: "success" | "waiting";
  }>;
  quota: {
    enabled: boolean;
    serviceRunning: boolean;
    serviceRecovered: boolean;
    healthStatus: "healthy" | "paused" | "offline" | "delayed";
    healthMessage: string;
    checkIntervalText: string;
    lastTickAt: string | null;
    nextCheckAt: string | null;
    lastWakeAt: string | null;
    lastMissedCheckCount: number;
    lastQuotaFetchAt: string | null;
    lastCallAt: string | null;
    lastSuccessAliases: string[];
    lastFailureByAlias: Record<string, string>;
    lastQuotaFetchAliases: string[];
  };
};
