import { useEffect, useState } from "react";
import type { UiStatus } from "../ui-status.ts";
import * as Badge from "./components/ui/badge.tsx";
import * as Divider from "./components/ui/divider.tsx";
import * as ProgressBar from "./components/ui/progress-bar.tsx";
import { toast, Toaster } from "./components/ui/toast.tsx";
import * as ToastAlert from "./components/ui/toast-alert.tsx";

type MetadataBadgeColor = "blue" | "gray" | "green" | "purple" | "red";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; status: UiStatus }
  | { kind: "error"; message: string };

export function App() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

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
  return <Dashboard status={state.status} />;
}

function Dashboard({ status }: { status: UiStatus }) {
  const failures = Object.entries(status.quota.lastFailureByAlias);

  return (
    <Shell>
      <section className="grid content-start gap-4">
        <AccountsCard accounts={status.accounts} />
      </section>
      <section className="grid content-start gap-4">
        <QuotaStatusCard quota={status.quota} />
        <QuotaRefreshCard accounts={status.accounts} />
        <QuotaResetCard accounts={status.accounts} />
      </section>
      <section className="grid content-start gap-4">
        <FailuresCard failures={failures} />
      </section>
      <QuotaToasts quota={status.quota} />
      <Toaster />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto grid min-h-screen w-full grid-cols-1 gap-4 bg-bg-weak-50 p-8  font-sans text-text-strong-950 antialiased lg:grid-cols-[minmax(0,1fr)_360px_420px]  ">
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
            自动任务和检查节奏
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
          description="自动检查账号 quota 和 5h reset 时间。"
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

function QuotaRefreshCard({ accounts }: { accounts: UiStatus["accounts"] }) {
  const refreshedCount = accounts.filter(
    (account) => account.lastQuotaFetchAt !== null,
  ).length;

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-label-lg text-text-strong-950">额度刷新</div>
          <div className="mt-1 text-paragraph-sm text-text-sub-600">
            显示 quota 更新时间和下次刷新时间
          </div>
        </div>
        <MetadataBadge color="blue" label={`${refreshedCount}`} />
      </div>
      <Divider.Root className="my-5" />
      <div className="grid gap-3">
        {accounts.map((account) => (
          <AccountStatusRow
            key={account.alias}
            description={`下次刷新：${formatDateTime(account.nextRefreshAt)}`}
            label={account.alias}
            status={
              account.lastQuotaFetchAt === null
                ? { color: "gray", label: "waiting" }
                : { color: "green", label: "updated" }
            }
            value={formatDateTime(account.lastQuotaFetchAt)}
          />
        ))}
      </div>
    </Card>
  );
}

function QuotaResetCard({ accounts }: { accounts: UiStatus["accounts"] }) {
  const successCount = accounts.filter(
    (account) => account.lastCallStatus === "success",
  ).length;

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-label-lg text-text-strong-950">额度重置</div>
          <div className="mt-1 text-paragraph-sm text-text-sub-600">
            显示 call 触发状态
          </div>
        </div>
        <MetadataBadge color="purple" label={`${successCount}`} />
      </div>
      <Divider.Root className="my-5" />
      <div className="grid gap-3">
        {accounts.map((account) => (
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
          <MetadataBadge color={status.color} label={status.label} />
          <div className="text-label-xs text-text-strong-950">{value}</div>
        </div>
      </div>
    </div>
  );
}

function AccountResetRow({
  account,
}: {
  account: UiStatus["accounts"][number];
}) {
  const plan = formatPlan(account.planType);
  if (plan === "free") {
    return (
      <AccountStatusRow
        description="free plan 不加入自动 call 重置额度。"
        label={account.alias}
        status={{ color: "gray", label: "free" }}
        value="跳过"
      />
    );
  }

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
      value="暂无"
    />
  );
}

function AccountsCard({ accounts }: { accounts: UiStatus["accounts"] }) {
  return (
    <Card className="min-h-[560px]">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-label-xl text-text-strong-950">账号 List</div>
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
            {accounts.map((account, index) => (
              <AccountRow
                account={account}
                isLast={index === accounts.length - 1}
                key={account.alias}
              />
            ))}
          </div>
        )}
      </div>
    </Card>
  );
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

  return (
    <>
      <article className="bg-bg-white-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate text-label-md text-text-strong-950">
                {account.alias}
              </div>
              {account.isActive ? (
                <MetadataBadge color="green" label="active" />
              ) : null}
            </div>
          </div>
        </div>
        <div
          className={`mt-4 grid gap-3 ${weeklyQuota !== null ? "md:grid-cols-2" : ""}`}
        >
          <QuotaBlock
            label="5h limit"
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
        <div className="mt-4 grid gap-2 text-paragraph-xs text-text-sub-600 sm:grid-cols-3">
          <span className="flex items-center gap-2">
            plan:
            <PlanBadge planType={account.planType} />
          </span>
          <span>subscription: {formatDate(account.subscriptionExpiresAt)}</span>
          <span>
            updated: {formatDateTime(account.quota?.updatedAt ?? null)}
          </span>
        </div>
      </article>
      {isLast ? null : (
        <div className="my-5 border-t border-dashed border-stroke-soft-200" />
      )}
    </>
  );
}

function FailuresCard({ failures }: { failures: Array<[string, string]> }) {
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
      <div className="grid gap-3">
        {failures.length === 0 ? (
          <div className="text-paragraph-sm text-text-sub-600">
            暂无失败账号
          </div>
        ) : (
          failures.map(([alias, reason]) => (
            <div className="rounded-20 bg-error-lighter p-3" key={alias}>
              <div className="text-label-sm text-error-base">{alias}</div>
              <div className="mt-1 text-paragraph-xs text-text-sub-600">
                {reason}
              </div>
            </div>
          ))
        )}
      </div>
    </Card>
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
        reset: {formatDateTime(resetAt)}
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

function QuotaToasts({ quota }: { quota: UiStatus["quota"] }) {
  useEffect(() => {
    if (quota.lastWakeAt !== null && quota.lastMissedCheckCount > 0) {
      const storageKey = `cxa-wake-toast:${quota.lastWakeAt}:${quota.lastMissedCheckCount}`;
      if (window.localStorage.getItem(storageKey) !== "seen") {
        window.localStorage.setItem(storageKey, "seen");
        toast.custom(
          (t) => (
            <ToastAlert.Root
              message={`休眠期间错过 ${formatCount(quota.lastMissedCheckCount)} 个检查周期，已在唤醒后重新检查。`}
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
          message="检测到自动刷新已开启但服务未运行，已重新启动后台检查。"
          status="success"
          t={t}
        />
      ),
      { duration: 5_000 },
    );
  }, [quota.serviceRecovered]);

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

function formatDateTime(value: string | null): string {
  if (value === null) return "暂无";
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
