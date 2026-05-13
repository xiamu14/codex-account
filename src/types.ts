export type LimitStatus = {
  percentLeft: number | null;
  resetsAt: string | null;
  rawReset: string | null;
};

export type AccountMeta = {
  alias: string;
  email: string | null;
  planType: string | null;
  subscriptionExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AccountQuota = {
  fiveHour: LimitStatus | null;
  weekly: LimitStatus | null;
  updatedAt: string;
};

export type AccountRecord = {
  alias: string;
  createdAt: string;
};

export type AccountsState = {
  version: 1;
  accounts: AccountRecord[];
  activeAccount: string | null;
  updatedAt: string;
};

export type AccountSummary = {
  alias: string;
  isActive: boolean;
  hasAuth: boolean;
  meta: AccountMeta | null;
  quota: AccountQuota | null;
};

export type AutoQuotaState = {
  version: 1;
  enabled: boolean;
  intervalMinutes: number;
  lastTickAt: string | null;
  lastCallAt: string | null;
  lastSuccessAliases: string[];
  lastFailureByAlias: Record<string, string>;
  consecutiveFailureCountByAlias: Record<string, number>;
  lastQuotaFetchAliases: string[];
  handledFiveHourResets: Record<string, string>;
  updatedAt: string;
};

export type AcpAccountInfo = {
  email: string | null;
  planType: string | null;
  subscriptionExpiresAt: string | null;
};

export type AcpSnapshot = {
  account: AcpAccountInfo;
  quota: AccountQuota;
};

export type AcpBestEffortSnapshot = {
  account: AcpAccountInfo;
  quota: AccountQuota | null;
  quotaError: string | null;
};

export type CommandContext = {
  appHome: string;
  codexHome: string;
  codexBin: string;
  cwd: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
};
