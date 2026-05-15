import { useEffect, useMemo, useState } from "react";
import type { UiStatus } from "../ui-status.ts";

type BadgeColor = "blue" | "gray" | "green" | "purple" | "red";

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
    return <Shell><EmptyPanel text="正在读取账号状态" /></Shell>;
  }
  if (state.kind === "error") {
    return <Shell><EmptyPanel text={state.message} /></Shell>;
  }
  return <Dashboard status={state.status} />;
}

function Dashboard({ status }: { status: UiStatus }) {
  const failures = Object.entries(status.quota.lastFailureByAlias);
  const nextRefresh = useMemo(
    () =>
      status.accounts
        .map((account) => account.nextRefreshAt)
        .filter((value): value is string => value !== null)
        .sort()[0] ?? null,
    [status.accounts],
  );

  return (
    <Shell>
      <section className="grid content-start gap-4">
        <AccountsCard accounts={status.accounts} />
      </section>
      <section className="grid content-start gap-4">
        <QuotaStatusCard quota={status.quota} failures={failures} />
      </section>
      <section className="grid content-start gap-4">
        <ScheduleCard accounts={status.accounts} nextRefresh={nextRefresh} />
        <FailuresCard failures={failures} />
      </section>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto grid min-h-screen w-full max-w-[1440px] grid-cols-1 gap-4 bg-bg-weak-50 p-4 font-sans text-text-strong-950 antialiased lg:grid-cols-[minmax(0,1fr)_360px_420px] lg:p-6">
      {children}
    </main>
  );
}

function QuotaStatusCard({
  quota,
  failures,
}: {
  quota: UiStatus["quota"];
  failures: Array<[string, string]>;
}) {
  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-label-lg text-text-strong-950">Quota Status</div>
          <div className="mt-1 text-paragraph-sm text-text-sub-600">
            {quota.enabled ? "自动刷新已开启" : "自动刷新未开启"}
          </div>
        </div>
        <Badge
          color={quota.serviceRunning ? "green" : "red"}
          label={quota.serviceRunning ? "service online" : "service off"}
        />
      </div>
      <Divider />
      <div className="grid gap-3">
        <StatusRow label="上次检查" value={formatDateTime(quota.lastTickAt)} />
        <StatusRow label="下次检查" value={formatDateTime(quota.nextCheckAt)} />
        <StatusRow label="上次额度刷新" value={formatDateTime(quota.lastQuotaFetchAt)} />
        <StatusRow label="上次触发重置" value={formatDateTime(quota.lastCallAt)} />
        <StatusRow label="失败账号" value={`${failures.length}`} />
      </div>
    </Card>
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
        <Badge color="blue" label={`${accounts.length} accounts`} />
      </div>
      <Divider />
      <div className="max-h-100 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-stone-300 [&::-webkit-scrollbar-track]:rounded-full [&::-webkit-scrollbar-track]:bg-stone-100">
        {accounts.length === 0 ? (
          <div className="rounded-20 border border-dashed border-stroke-soft-200 p-8 text-center text-paragraph-sm text-text-sub-600">
            还没有保存账号
          </div>
        ) : (
          accounts.map((account, index) => (
            <AccountRow
              account={account}
              isLast={index === accounts.length - 1}
              key={account.alias}
            />
          ))
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
  const weekly = account.quota?.weekly?.percentLeft ?? null;

  return (
    <>
      <article className="bg-bg-white-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate text-label-md text-text-strong-950">{account.alias}</div>
              {account.isActive ? <Badge color="green" label="active" /> : null}
            </div>
          </div>
          <Badge
            color={account.hasAuth ? "blue" : "red"}
            label={account.hasAuth ? "token" : "no token"}
          />
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <QuotaBlock
            label="5h limit"
            percent={fiveHour}
            resetAt={account.quota?.fiveHour?.resetsAt ?? null}
          />
          <QuotaBlock
            label="weekly"
            percent={weekly}
            resetAt={account.quota?.weekly?.resetsAt ?? null}
          />
        </div>
        <div className="mt-4 grid gap-2 text-paragraph-xs text-text-sub-600 sm:grid-cols-3">
          <span>plan: {account.planType ?? "unknown"}</span>
          <span>subscription: {formatDate(account.subscriptionExpiresAt)}</span>
          <span>updated: {formatDateTime(account.quota?.updatedAt ?? null)}</span>
        </div>
      </article>
      {isLast ? null : <div className="my-5 border-t border-dashed border-stroke-soft-200" />}
    </>
  );
}

function ScheduleCard({
  accounts,
  nextRefresh,
}: {
  accounts: UiStatus["accounts"];
  nextRefresh: string | null;
}) {
  const sorted = [...accounts]
    .filter((account) => account.nextRefreshAt !== null)
    .sort((left, right) => String(left.nextRefreshAt).localeCompare(String(right.nextRefreshAt)));

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-label-lg text-text-strong-950">下次刷新</div>
          <div className="mt-1 text-paragraph-sm text-text-sub-600">
            {formatDateTime(nextRefresh)}
          </div>
        </div>
        <Badge color="purple" label="schedule" />
      </div>
      <Divider />
      <div className="grid gap-3">
        {sorted.length === 0 ? (
          <div className="text-paragraph-sm text-text-sub-600">没有可计算的下次刷新时间</div>
        ) : (
          sorted.map((account) => (
            <StatusRow
              key={account.alias}
              label={account.alias}
              value={formatDateTime(account.nextRefreshAt)}
            />
          ))
        )}
      </div>
    </Card>
  );
}

function FailuresCard({ failures }: { failures: Array<[string, string]> }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="text-label-lg text-text-strong-950">失败记录</div>
        <Badge color={failures.length === 0 ? "gray" : "red"} label={`${failures.length}`} />
      </div>
      <Divider />
      <div className="grid gap-3">
        {failures.length === 0 ? (
          <div className="text-paragraph-sm text-text-sub-600">暂无失败账号</div>
        ) : (
          failures.map(([alias, reason]) => (
            <div className="rounded-20 bg-error-lighter p-3" key={alias}>
              <div className="text-label-sm text-error-base">{alias}</div>
              <div className="mt-1 text-paragraph-xs text-text-sub-600">{reason}</div>
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
  const width = `${Math.max(0, Math.min(100, percent ?? 0))}%`;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-label-sm text-text-strong-950">{label}</span>
        <span className={`text-label-sm ${tone.textClass}`}>
          {percent === null ? "unknown" : `${percent}%`}
        </span>
      </div>
      <div className="h-2 rounded-full bg-bg-weak-50">
        <div
          className={`h-2 rounded-full transition-[width] duration-700 ease-out ${tone.barClass}`}
          style={{ width }}
        />
      </div>
      <div className="mt-2 text-paragraph-xs text-text-sub-600">reset: {formatDateTime(resetAt)}</div>
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
    <div className={`rounded-20 border border-stroke-soft-200 bg-bg-white-0 p-6 shadow-regular-md ${className}`}>
      {children}
    </div>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-paragraph-sm text-text-sub-600">{label}</span>
      <span className="text-right text-label-sm text-text-strong-950">{value}</span>
    </div>
  );
}

function Badge({ label, color }: { label: string; color: BadgeColor }) {
  const colorClass: Record<BadgeColor, string> = {
    blue: "bg-information-lighter text-information-base",
    gray: "bg-faded-lighter text-faded-base",
    green: "bg-success-lighter text-success-base",
    purple: "bg-feature-lighter text-feature-base",
    red: "bg-error-lighter text-error-base",
  };
  return (
    <span className={`inline-flex h-5 items-center justify-center rounded-full px-2 text-label-xs ${colorClass[color]}`}>
      {label}
    </span>
  );
}

function Divider() {
  return <div className="my-5 h-px w-full border-t border-dashed border-stroke-soft-200" />;
}

function quotaTone(percent: number | null): {
  barClass: string;
  textClass: string;
} {
  if (percent === null) {
    return { barClass: "bg-faded-base", textClass: "text-text-sub-600" };
  }
  if (percent >= 70) {
    return { barClass: "bg-success-base", textClass: "text-success-base" };
  }
  if (percent >= 40) {
    return { barClass: "bg-information-base", textClass: "text-information-base" };
  }
  if (percent >= 20) {
    return { barClass: "bg-warning-base", textClass: "text-warning-base" };
  }
  return { barClass: "bg-error-base", textClass: "text-error-base" };
}

async function fetchStatus(): Promise<UiStatus> {
  const response = await fetch("/api/status");
  if (!response.ok) {
    throw new Error(`状态读取失败：${response.status}`);
  }
  return await response.json() as UiStatus;
}

function formatDateTime(value: string | null): string {
  if (value === null) return "暂无";
  if (value.includes(" - ")) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "暂无";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
