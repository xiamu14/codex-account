import { useEffect, useState } from "react";
import { RiCheckboxCircleFill } from "@remixicon/react";
import { isSubscriptionPlan } from "../account-priority.ts";
import type { UiStatus } from "../ui-status.ts";
import * as Badge from "./components/ui/badge.tsx";
import * as Button from "./components/ui/button.tsx";
import * as Divider from "./components/ui/divider.tsx";
import * as ProgressBar from "./components/ui/progress-bar.tsx";
import * as Select from "./components/ui/select.tsx";
import * as StatusBadge from "./components/ui/status-badge.tsx";
import { toast, Toaster } from "./components/ui/toast.tsx";
import * as ToastAlert from "./components/ui/toast-alert.tsx";

type MetadataBadgeColor = "blue" | "gray" | "green" | "purple" | "red";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; status: UiStatus }
  | { kind: "error"; message: string };

const hiddenScrollListClass =
  "grid max-h-56 gap-3 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
const shownToastKeys = new Set<string>();

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [isActivatingAccount, setIsActivatingAccount] = useState(false);
  const [isRetryingQuota, setIsRetryingQuota] = useState(false);

  useEffect(() => {
    let mounted = true;

    fetchStatus()
      .then((status) => {
        if (mounted) setState({ kind: "ready", status });
      })
      .catch((error: unknown) => {
        if (mounted) setState({ kind: "error", message: errorMessage(error) });
      });

    if (!window.EventSource) {
      return () => {
        mounted = false;
      };
    }

    const source = new EventSource("/api/events");
    source.addEventListener("status", (event) => {
      if (!mounted) return;
      try {
        const status = JSON.parse(event.data) as UiStatus;
        setState({ kind: "ready", status });
      } catch (error) {
        setState({ kind: "error", message: errorMessage(error) });
      }
    });
    source.addEventListener("error", () => {
      if (mounted && state.kind === "loading") {
        setState({ kind: "error", message: "无法连接本地状态服务" });
      }
    });

    return () => {
      mounted = false;
      source.close();
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <Shell>
        <EmptyPanel text="正在读取账号状态" />
      </Shell>
    );
  }
  if (state.kind === "error") {
    return (
      <Shell>
        <EmptyPanel text={state.message} />
      </Shell>
    );
  }
  return (
    <Dashboard
      isActivatingAccount={isActivatingAccount}
      isRetryingQuota={isRetryingQuota}
      onActivateAccount={async (alias) => {
        setIsActivatingAccount(true);
        try {
          const status = await activateAccount(alias);
          setState({ kind: "ready", status });
          toast.custom(
            (t) => (
              <ToastAlert.Root
                message={`账号 ${alias} 已激活`}
                status="success"
                t={t}
              />
            ),
            { duration: 4_000 },
          );
        } catch (error) {
          toast.custom(
            (t) => (
              <ToastAlert.Root
                message={errorMessage(error)}
                status="error"
                t={t}
              />
            ),
            { duration: 5_000 },
          );
        } finally {
          setIsActivatingAccount(false);
        }
      }}
      onRetryQuota={async () => {
        setIsRetryingQuota(true);
        try {
          const status = await retryQuota();
          setState({ kind: "ready", status });
          toast.custom(
            (t) => (
              <ToastAlert.Root
                message="已重新刷新额度。"
                status="success"
                t={t}
              />
            ),
            { duration: 4_000 },
          );
        } catch (error) {
          toast.custom(
            (t) => (
              <ToastAlert.Root
                message={errorMessage(error)}
                status="error"
                t={t}
              />
            ),
            { duration: 5_000 },
          );
        } finally {
          setIsRetryingQuota(false);
        }
      }}
      status={state.status}
    />
  );
}

function Dashboard({
  isActivatingAccount,
  isRetryingQuota,
  onActivateAccount,
  onRetryQuota,
  status,
}: {
  isActivatingAccount: boolean;
  isRetryingQuota: boolean;
  onActivateAccount: (alias: string) => Promise<void>;
  onRetryQuota: () => Promise<void>;
  status: UiStatus;
}) {
  const failures = Object.entries(status.quota.lastFailureByAlias);

  return (
    <Shell>
      <section className="grid min-w-0 content-start gap-4">
        <AccountsCard accounts={status.accounts} />
      </section>
      <section className="grid min-w-0 content-start gap-4">
        <SwitchAccountCard
          accounts={status.accounts}
          isActivating={isActivatingAccount}
          onActivate={onActivateAccount}
        />
        <QuotaRefreshCard
          accounts={status.accounts}
          nextQuotaFetchAt={status.quota.nextCheckAt}
        />
        <QuotaResetCard accounts={status.accounts} />
      </section>
      <section className="grid min-w-0 content-start gap-4">
        <QuotaStatusCard quota={status.quota} />
        <FailuresCard
          failures={failures}
          isRetrying={isRetryingQuota}
          onRetry={onRetryQuota}
        />
      </section>
      <QuotaToasts accounts={status.accounts} quota={status.quota} />
      <Toaster />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-[1500px] grid-cols-1 gap-4 bg-bg-weak-50 p-6 font-sans text-text-strong-950 antialiased md:p-8 lg:grid-cols-[minmax(0,1.08fr)_minmax(280px,0.92fr)_minmax(260px,0.82fr)] xl:px-10 2xl:px-12">
      {children}
    </main>
  );
}

function QuotaStatusCard({ quota }: { quota: UiStatus["quota"] }) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-label-lg text-text-strong-950">定时任务</div>
          <div className="mt-1 text-paragraph-sm text-text-sub-600">
            自动任务、刷新额度和重置额度
          </div>
        </div>
        <MetadataBadge
          color={serviceBadgeColor(quota)}
          label={serviceBadgeLabel(quota)}
        />
      </div>
      <Divider.Root className="my-5" />
      <div className="grid gap-3">
        <StatusDetailRow
          description=""
          label="运行间隔"
          value={quota.checkIntervalText}
        />
        <StatusDetailRow
          description=""
          label="最近任务"
          value={formatDateTime(quota.lastTickAt)}
        />
        <StatusDetailRow
          description=""
          label="下次任务"
          value={formatDateTime(quota.nextCheckAt)}
        />
      </div>
    </Card>
  );
}

function QuotaRefreshCard({
  accounts,
  nextQuotaFetchAt,
}: {
  accounts: UiStatus["accounts"];
  nextQuotaFetchAt: string | null;
}) {
  const orderedAccounts = sortAccountsForDisplay(accounts);
  const refreshedCount = accounts.filter(
    (account) => account.lastQuotaFetchAt !== null,
  ).length;

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-label-lg text-text-strong-950">额度刷新</div>
          <div className="mt-1 text-paragraph-sm text-text-sub-600">
            额度刷新时间
          </div>
        </div>
        <MetadataBadge color="blue" label={`${refreshedCount}`} />
      </div>
      <Divider.Root className="my-5" />
      <div className={hiddenScrollListClass}>
        {orderedAccounts.map((account) => (
          <AccountStatusRow
            key={account.alias}
            description={`下次刷新：${formatDateTime(nextQuotaFetchAt)}`}
            label={account.alias}
            status={
              account.lastQuotaFetchAt === null
                ? { color: "gray", label: "waiting" }
                : { color: "green", label: "updated" }
            }
            value={""}
          />
        ))}
      </div>
    </Card>
  );
}

function QuotaResetCard({ accounts }: { accounts: UiStatus["accounts"] }) {
  const orderedAccounts = sortAccountsForDisplay(accounts);
  const successCount = accounts.filter(
    (account) => account.lastCallStatus === "success",
  ).length;

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-label-lg text-text-strong-950">额度重置</div>
          <div className="mt-1 text-paragraph-sm text-text-sub-600">
            额度重置触发状态
          </div>
        </div>
        <MetadataBadge color="purple" label={`${successCount}`} />
      </div>
      <Divider.Root className="my-5" />
      <div className={hiddenScrollListClass}>
        {orderedAccounts.map((account) => (
          <AccountResetRow account={account} key={account.alias} />
        ))}
      </div>
    </Card>
  );
}

function AccountStatusRow({
  description,
  label,
  status,
  value,
}: {
  description: string;
  label: string;
  status: { color: MetadataBadgeColor; label: string };
  value: string;
}) {
  return (
    <div className="grid gap-1">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-label-sm text-text-strong-950">
            {label}
          </div>
          <div className="mt-1 text-paragraph-xs text-text-sub-600">
            {description}
          </div>
        </div>
        <div className="grid justify-items-end gap-1 text-right">
          <AccountStatusBadge status={status} />
          <div className="text-label-xs text-text-strong-950">{value}</div>
        </div>
      </div>
    </div>
  );
}

function AccountStatusBadge({
  status,
}: {
  status: { color: MetadataBadgeColor; label: string };
}) {
  if (status.label === "updated") {
    return (
      <StatusBadge.Root status="completed">
        <StatusBadge.Icon as={RiCheckboxCircleFill} />
        updated
      </StatusBadge.Root>
    );
  }

  if (status.label === "waiting") {
    return (
      <StatusBadge.Root status="pending" variant="light">
        <StatusBadge.Dot />
        waiting
      </StatusBadge.Root>
    );
  }

  return <MetadataBadge color={status.color} label={status.label} />;
}

function AccountResetRow({
  account,
}: {
  account: UiStatus["accounts"][number];
}) {
  if (account.lastCallStatus === "success") {
    return (
      <AccountStatusRow
        description="最近一轮已成功触发 reset call。"
        label={account.alias}
        status={{ color: "green", label: "success" }}
        value={formatDateTime(account.lastCallAt)}
      />
    );
  }

  return (
    <AccountStatusRow
      description={`下次重置：${formatDateTime(account.nextRefreshAt)}`}
      label={account.alias}
      status={{ color: "gray", label: "waiting" }}
      value=""
    />
  );
}

function UsagePriorityBadge({
  account,
  compact = false,
}: {
  account: UiStatus["accounts"][number];
  compact?: boolean;
}) {
  if (account.isRecommendedNext) {
    return (
      <StatusBadge.Root status="completed" variant="light">
        <StatusBadge.Dot />
        next
      </StatusBadge.Root>
    );
  }
  if (account.usagePriority.status === "usable") {
    return (
      <StatusBadge.Root status="pending" variant={compact ? "stroke" : "light"}>
        <StatusBadge.Dot />
        {account.usagePriority.label}
      </StatusBadge.Root>
    );
  }
  if (account.usagePriority.status === "blocked") {
    return (
      <StatusBadge.Root status="failed" variant="light">
        <StatusBadge.Dot />
        blocked
      </StatusBadge.Root>
    );
  }
  return (
    <StatusBadge.Root status="disabled" variant="stroke">
      <StatusBadge.Dot />
      unknown
    </StatusBadge.Root>
  );
}

function formatPrimaryQuotaLabel(
  account: UiStatus["accounts"][number],
): string {
  if (isSubscriptionPlan(account.planType)) return "5h limit";
  if (account.usagePriority.primaryWindow === "short") return "short limit";
  if (account.usagePriority.primaryWindow === "daily") return "daily limit";
  if (account.usagePriority.primaryWindow === "weekly") {
    return "weekly-like limit";
  }
  return "primary limit";
}

function AccountsCard({ accounts }: { accounts: UiStatus["accounts"] }) {
  return (
    <Card className="min-h-[560px]">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-label-lg text-text-strong-950">账号列表</div>
          <div className="mt-1 text-paragraph-sm text-text-sub-600">
            本地账号、token 和额度缓存
          </div>
        </div>
        <MetadataBadge color="blue" label={`${accounts.length} accounts`} />
      </div>
      <Divider.Root className="my-5" />
      <div className="max-h-100 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-stone-100">
        {accounts.length === 0 ? (
          <div className="rounded-20 border border-dashed border-stroke-soft-200 p-8 text-center text-paragraph-sm text-text-sub-600">
            还没有保存账号
          </div>
        ) : (
          <div className="px-4">
            {sortAccountsForDisplay(accounts).map(
              (account, index, sortedAccounts) => (
                <AccountRow
                  account={account}
                  isLast={index === sortedAccounts.length - 1}
                  key={account.alias}
                />
              ),
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function SwitchAccountCard({
  accounts,
  isActivating,
  onActivate,
}: {
  accounts: UiStatus["accounts"];
  isActivating: boolean;
  onActivate: (alias: string) => Promise<void>;
}) {
  const activeAlias =
    accounts.find((account) => account.isActive)?.alias ??
    accounts[0]?.alias ??
    "";
  const inactiveAccounts = sortAccountsForDisplay(accounts).filter(
    (account) => account.alias !== activeAlias,
  );
  const hasUsableInactiveAccount = inactiveAccounts.some(
    (account) => account.usagePriority.status === "usable",
  );
  const recommendedAlias =
    inactiveAccounts.find((account) => account.isRecommendedNext)?.alias ?? "";
  const defaultAlias = recommendedAlias || inactiveAccounts[0]?.alias || "";
  const [selectedAlias, setSelectedAlias] = useState(defaultAlias);

  useEffect(() => {
    setSelectedAlias(defaultAlias);
  }, [defaultAlias]);

  const selectedAccount =
    inactiveAccounts.find((account) => account.alias === selectedAlias) ?? null;
  const canActivate =
    selectedAlias.trim().length > 0 &&
    hasUsableInactiveAccount &&
    !isActivating;
  const showRecommendation =
    recommendedAlias !== "" && selectedAlias === recommendedAlias;

  return (
    <Card>
      <div className="text-label-lg text-text-strong-950">切换账号</div>
      <Divider.Root className="my-5" />
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <Select.Root
            disabled={!hasUsableInactiveAccount || isActivating}
            onValueChange={setSelectedAlias}
            value={selectedAlias}
          >
            <Select.Trigger>
              {selectedAccount === null ? (
                <Select.Value placeholder="暂无可切换账号" />
              ) : (
                <span className="flex min-w-0 items-center gap-2">
                  {showRecommendation ? (
                    <span className="size-2 shrink-0 rounded-full bg-success-base" />
                  ) : null}
                  <span className="truncate">{selectedAccount.alias}</span>
                </span>
              )}
            </Select.Trigger>
            <Select.Content>
              {inactiveAccounts.map((account) => (
                <Select.Item key={account.alias} value={account.alias}>
                  {account.alias}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          {showRecommendation ? (
            <div className="mt-2 text-paragraph-xs text-text-sub-600">
              下一个账号建议使用
            </div>
          ) : null}
        </div>
        <Button.Root
          aria-busy={isActivating}
          disabled={!canActivate}
          onClick={() => {
            if (!canActivate) return;
            void onActivate(selectedAlias);
          }}
          className={"w-[80px]"}
          mode="filled"
        >
          {isActivating ? <LoadingSpinner /> : null}
          确定
        </Button.Root>
      </div>
    </Card>
  );
}

function LoadingSpinner() {
  return (
    <span
      aria-hidden="true"
      className="size-4 animate-spin rounded-full border-2 border-static-white/35 border-t-static-white"
    />
  );
}

function sortAccountsForDisplay(
  accounts: UiStatus["accounts"],
): UiStatus["accounts"] {
  return [...accounts].sort((left, right) => {
    const leftRank = left.usagePriority.rank ?? Number.MAX_SAFE_INTEGER;
    const rightRank = right.usagePriority.rank ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.usagePriority.status !== right.usagePriority.status) {
      return statusSortValue(left) - statusSortValue(right);
    }
    return accounts.indexOf(left) - accounts.indexOf(right);
  });
}

function statusSortValue(account: UiStatus["accounts"][number]): number {
  if (account.usagePriority.status === "usable") return 0;
  if (account.usagePriority.status === "unknown") return 1;
  return 2;
}

function AccountRow({
  account,
  isLast,
}: {
  account: UiStatus["accounts"][number];
  isLast: boolean;
}) {
  const fiveHour = account.quota?.fiveHour?.percentLeft ?? null;
  const weeklyQuota = account.quota?.weekly ?? null;
  const primaryQuotaLabel = formatPrimaryQuotaLabel(account);

  return (
    <>
      <article className="bg-bg-white-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 w-full">
            <div className="flex items-center gap-2">
              <div className="truncate text-label-md text-text-strong-950">
                {account.alias}
              </div>
              {account.isActive ? (
                <MetadataBadge color="green" label="active" />
              ) : null}
              <PlanBadge planType={account.planType} />
              <div className="flex-1"></div>

              {account.subscriptionExpiresAt ? (
                <div className="text-paragraph-xs text-text-sub-600">
                  <span>{formatDate(account.subscriptionExpiresAt)}</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
        <div
          className={`mt-4 grid gap-4 ${weeklyQuota !== null ? "md:grid-cols-2" : ""}`}
        >
          <QuotaBlock
            label={primaryQuotaLabel}
            percent={fiveHour}
            resetAt={account.quota?.fiveHour?.resetsAt ?? null}
          />
          {weeklyQuota !== null ? (
            <QuotaBlock
              label="weekly"
              percent={weeklyQuota.percentLeft}
              resetAt={weeklyQuota.resetsAt}
            />
          ) : null}
        </div>
      </article>
      {isLast ? null : (
        <div className="my-5 border-t border-dashed border-stroke-soft-200" />
      )}
    </>
  );
}

function FailuresCard({
  failures,
  isRetrying,
  onRetry,
}: {
  failures: Array<[string, string]>;
  isRetrying: boolean;
  onRetry: () => Promise<void>;
}) {
  const hasFailures = failures.length > 0;

  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="text-label-lg text-text-strong-950">失败记录</div>
        <MetadataBadge
          color={failures.length === 0 ? "gray" : "red"}
          label={`${failures.length}`}
        />
      </div>
      <Divider.Root className="my-5" />
      {hasFailures ? (
        <>
          <div className="grid gap-3">
            {failures.map(([alias, reason]) => (
              <div className="flex items-start gap-3 px-1 py-2" key={alias}>
                <span
                  aria-hidden="true"
                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-error-base"
                />
                <div className="min-w-0">
                  <div className="truncate text-label-sm text-text-strong-950">
                    {alias}
                  </div>
                  {formatFailureReason(reason) === "" ? null : (
                    <div className="mt-0.5 text-paragraph-xs text-text-sub-600">
                      {formatFailureReason(reason)}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="my-5 " />
          <Button.Root
            aria-busy={isRetrying}
            className="w-full"
            disabled={isRetrying}
            mode="stroke"
            onClick={() => {
              void onRetry();
            }}
            variant="neutral"
          >
            重试
          </Button.Root>
        </>
      ) : (
        <EmptyStateImage />
      )}
    </Card>
  );
}

function EmptyStateImage() {
  return (
    <div className="flex justify-center py-1.5">
      <img
        alt=""
        className="h-[80px] w-auto"
        src="/assets/undraw_searching-everywhere_tffi.svg"
      />
    </div>
  );
}

function QuotaBlock({
  label,
  percent,
  resetAt,
}: {
  label: string;
  percent: number | null;
  resetAt: string | null;
}) {
  const tone = quotaTone(percent);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-label-sm text-text-strong-950">{label}</span>
        <span className={`text-label-sm ${tone.textClass}`}>
          {percent === null ? "unknown" : `${percent}%`}
        </span>
      </div>
      <ProgressBar.Root color={tone.progressColor} value={percent ?? 0} />
      <div className="mt-2 text-paragraph-xs text-text-sub-600">
        重置: {formatDateTime(resetAt)}
      </div>
    </div>
  );
}

function EmptyPanel({ text }: { text: string }) {
  return (
    <section className="lg:col-span-3">
      <Card>
        <div className="text-paragraph-sm text-text-sub-600">{text}</div>
      </Card>
    </section>
  );
}

function Card({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-20 border border-stroke-soft-200 bg-bg-white-0 p-6 shadow-regular-md ${className}`}
    >
      {children}
    </div>
  );
}

function StatusDetailRow({
  description,
  label,
  value,
}: {
  description: string;
  label: string;
  value: string;
}) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center justify-between gap-4">
        <span className="text-label-sm text-text-strong-950">{label}</span>
        <span className="text-right text-label-sm text-text-strong-950">
          {value}
        </span>
      </div>
      <div className="text-paragraph-xs text-text-sub-600">{description}</div>
    </div>
  );
}

function QuotaToasts({
  accounts,
  quota,
}: {
  accounts: UiStatus["accounts"];
  quota: UiStatus["quota"];
}) {
  const activeQuotaWarning = getActiveQuotaWarning(accounts);

  useEffect(() => {
    if (quota.lastWakeAt !== null && quota.lastMissedCheckCount > 0) {
      const storageKey = `cxa-wake-toast:${quota.lastWakeAt}:${quota.lastMissedCheckCount}`;
      if (window.localStorage.getItem(storageKey) !== "seen") {
        window.localStorage.setItem(storageKey, "seen");
        toast.custom(
          (t) => (
            <ToastAlert.Root
              message={`休眠期间检查停止，已重新检查。`}
              status="success"
              t={t}
            />
          ),
          { duration: 5_000 },
        );
      }
    }
  }, [quota.lastMissedCheckCount, quota.lastWakeAt]);

  useEffect(() => {
    if (!quota.serviceRecovered) return;
    toast.custom(
      (t) => (
        <ToastAlert.Root
          message="自动刷新服务未运行，已重新启动。"
          status="success"
          t={t}
        />
      ),
      { duration: 5_000 },
    );
  }, [quota.serviceRecovered]);

  useEffect(() => {
    notifyActiveQuotaWarning(activeQuotaWarning);
  }, [activeQuotaWarning]);

  useEffect(() => {
    const onFocus = () => {
      notifyActiveQuotaWarning(activeQuotaWarning);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [activeQuotaWarning]);

  return null;
}

function MetadataBadge({
  color,
  label,
}: {
  color: MetadataBadgeColor;
  label: string;
}) {
  return (
    <Badge.Root color={badgeColor(color)} size="medium" variant="lighter">
      {label}
    </Badge.Root>
  );
}

function PlanBadge({ planType }: { planType: string | null }) {
  const plan = formatPlan(planType);
  return (
    <Badge.Root color={planBadgeColor(plan)} size="medium" variant="lighter">
      {plan}
    </Badge.Root>
  );
}

function quotaTone(percent: number | null): {
  progressColor: "blue" | "green" | "orange" | "red";
  textClass: string;
} {
  if (percent === null) {
    return { progressColor: "blue", textClass: "text-text-sub-600" };
  }
  if (percent >= 70) {
    return { progressColor: "green", textClass: "text-success-base" };
  }
  if (percent >= 40) {
    return { progressColor: "blue", textClass: "text-information-base" };
  }
  if (percent >= 20) {
    return { progressColor: "orange", textClass: "text-warning-base" };
  }
  return { progressColor: "red", textClass: "text-error-base" };
}

async function fetchStatus(): Promise<UiStatus> {
  const response = await fetch("/api/status");
  if (!response.ok) {
    throw new Error(`状态读取失败：${response.status}`);
  }
  return (await response.json()) as UiStatus;
}

async function retryQuota(): Promise<UiStatus> {
  const response = await fetch("/api/quota/retry", { method: "POST" });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message.trim() || `重试失败：${response.status}`);
  }
  return (await response.json()) as UiStatus;
}

async function activateAccount(alias: string): Promise<UiStatus> {
  const response = await fetch("/api/accounts/active", {
    body: JSON.stringify({ alias }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message.trim() || `切换失败：${response.status}`);
  }
  return (await response.json()) as UiStatus;
}

function formatFailureReason(value: string): string {
  const normalized = value.trim().replace(/[。.]$/, "");
  if (normalized === "读取额度失败") return "";
  return value;
}

function formatCompactAccountLabel(alias: string): string {
  const trimmed = alias.trim();
  if (trimmed.length <= 18) return trimmed;

  const atIndex = trimmed.indexOf("@");
  if (atIndex > 0) {
    const name = trimmed.slice(0, atIndex);
    const domain = trimmed.slice(atIndex + 1);
    const compactName = name.length > 6 ? `${name.slice(0, 6)}...` : name;
    const compactDomain =
      domain === "gmail.com" ? "gmail" : domain.split(".")[0] || domain;
    return `${compactName}@${compactDomain}`;
  }

  return `${trimmed.slice(0, 15)}...`;
}

function getActiveQuotaWarning(
  accounts: UiStatus["accounts"],
): { key: string; message: string } | null {
  const activeAccount = accounts.find((account) => account.isActive);
  if (activeAccount === undefined) return null;

  const exhaustedLimits = [
    activeAccount.quota?.fiveHour?.percentLeft === 0 ? "5h" : null,
    activeAccount.quota?.weekly?.percentLeft === 0 ? "weekly" : null,
  ].filter((value): value is string => value !== null);

  if (exhaustedLimits.length === 0) return null;

  const quotaUpdatedAt = activeAccount.quota?.updatedAt ?? "unknown";
  const key = [
    "cxa-active-quota-toast",
    activeAccount.alias,
    quotaUpdatedAt,
    exhaustedLimits.join("+"),
  ].join(":");
  return {
    key,
    message: `${formatCompactAccountLabel(activeAccount.alias)} ${exhaustedLimits.join(" / ")} 额度已用完，切换账号。`,
  };
}

function notifyActiveQuotaWarning(
  warning: { key: string; message: string } | null,
): void {
  if (warning === null) return;
  if (shownToastKeys.has(warning.key)) return;
  if (window.localStorage.getItem(warning.key) === "seen") return;
  shownToastKeys.add(warning.key);
  window.localStorage.setItem(warning.key, "seen");
  toast.custom(
    (t) => <ToastAlert.Root message={warning.message} status="warning" t={t} />,
    { duration: 6_000 },
  );
}

function formatDateTime(value: string | null): string {
  if (value === null) return "";
  if (value.includes(" - ")) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(value: string | null): string {
  if (value === null) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  });
}

function formatPlan(value: string | null): string {
  return value === null || value.trim().length === 0
    ? "free"
    : value.trim().toLowerCase();
}

function formatCount(value: number): string {
  return Number.isFinite(value) ? `${value}` : "0";
}

function badgeColor(
  color: MetadataBadgeColor,
): "blue" | "gray" | "green" | "purple" | "red" {
  return color;
}

function planBadgeColor(plan: string): "gray" | "orange" | "pink" {
  if (plan === "plus") return "orange";
  if (plan === "pro") return "pink";
  return "gray";
}

function serviceBadgeColor(quota: UiStatus["quota"]): MetadataBadgeColor {
  return quota.enabled && quota.serviceRunning ? "green" : "red";
}

function serviceBadgeLabel(quota: UiStatus["quota"]): string {
  return quota.enabled && quota.serviceRunning ? "active" : "offline";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
