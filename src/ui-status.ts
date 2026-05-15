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
  }>;
  quota: {
    enabled: boolean;
    serviceRunning: boolean;
    lastTickAt: string | null;
    nextCheckAt: string | null;
    lastQuotaFetchAt: string | null;
    lastCallAt: string | null;
    lastSuccessAliases: string[];
    lastFailureByAlias: Record<string, string>;
    lastQuotaFetchAliases: string[];
  };
};
