import chalk from 'chalk';
import type { AccountSummary, LimitStatus } from './types.ts';

export function renderList(accounts: AccountSummary[]): string {
  if (accounts.length === 0) {
    return '没有账号。请先登录 Codex，然后运行 cxa save。';
  }
  return sortAccountsForList(accounts).map(renderAccount).join('\n\n');
}

export function sortAccountsForList(accounts: AccountSummary[]): AccountSummary[] {
  return accounts
    .map((account, index) => ({ account, index }))
    .sort((left, right) => {
      const activeDelta = Number(right.account.isActive) - Number(left.account.isActive);
      if (activeDelta !== 0) return activeDelta;

      const fiveHourDelta =
        limitSortValue(right.account.quota?.fiveHour ?? null) - limitSortValue(left.account.quota?.fiveHour ?? null);
      if (fiveHourDelta !== 0) return fiveHourDelta;

      const weeklyDelta =
        limitSortValue(right.account.quota?.weekly ?? null) - limitSortValue(left.account.quota?.weekly ?? null);
      if (weeklyDelta !== 0) return weeklyDelta;

      return left.index - right.index;
    })
    .map(({ account }) => account);
}

function renderAccount(account: AccountSummary): string {
  const marker = account.isActive ? chalk.green.bold('*') : ' ';
  const email = account.meta?.email ?? 'unknown';
  const plan = account.meta?.planType ?? 'unknown';
  const subscription = renderSubscription(account.meta?.subscriptionExpiresAt ?? null);
  const fiveHour = renderLimit(account.quota?.fiveHour ?? null);
  const weekly = renderLimit(account.quota?.weekly ?? null);
  const updatedAt = formatDateTime(account.quota?.updatedAt ?? account.meta?.updatedAt ?? null);
  const rows = [
    `${marker} ${chalk.bold(account.alias)}${account.isActive ? chalk.green('  active') : ''}`,
    ...(email !== 'unknown' && email !== account.alias ? [renderRow('email', email)] : []),
    renderRow('plan', plan),
    renderRow('subscription', subscription),
    renderRow('5h limit', fiveHour, true),
    renderRow('weekly', weekly, true),
    renderRow('updated', updatedAt)
  ];
  return rows.join('\n');
}

function renderLimit(limit: LimitStatus | null): string {
  if (limit === null) return chalk.dim('unknown');
  if (limit.percentLeft === null) return chalk.dim('unknown');
  const left = colorizeLimit(limit.percentLeft, `${limit.percentLeft}% left`);
  const reset = limit.rawReset ?? limit.resetsAt;
  const warning = limit.percentLeft <= 10 ? chalk.red.bold('  LOW') : limit.percentLeft <= 25 ? chalk.yellow.bold('  LOW') : '';
  return reset ? `${left}${warning}, ${chalk.dim('resets')} ${formatDateTime(reset)}` : `${left}${warning}`;
}

function limitSortValue(limit: LimitStatus | null): number {
  return limit?.percentLeft ?? -1;
}

function renderSubscription(value: string | null): string {
  if (value === null || value.trim().length === 0) return chalk.dim('unknown');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return formatDateTime(value);

  const formatted = formatDateTime(value);
  const now = new Date();
  const daysLeft = Math.ceil((date.getTime() - now.getTime()) / 86_400_000);
  if (daysLeft < 0) {
    return `${chalk.bgRed.white.bold(` ${formatted} `)}${chalk.red.bold('  EXPIRED')}`;
  }
  if (daysLeft <= 2) {
    return `${chalk.yellow.bold(formatted)}${chalk.yellow.bold(`  expires in ${daysLeft}d`)}`;
  }
  return formatted;
}

export function formatDateTime(value: string | null): string {
  if (value === null || value.trim().length === 0) return 'unknown';
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hour = pad(date.getHours());
    const minute = pad(date.getMinutes());
    const second = pad(date.getSeconds());
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  }
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, '').replace(/Z$/, '');
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

function colorizeLimit(percentLeft: number, text: string): string {
  if (percentLeft <= 10) return chalk.bgRed.white.bold(` ${text} `);
  if (percentLeft <= 25) return chalk.yellow.bold(text);
  if (percentLeft <= 50) return chalk.cyan.bold(text);
  return chalk.green.bold(text);
}

function renderRow(label: string, value: string, important = false): string {
  const paddedLabel = label.padEnd(14);
  const labelText = important ? chalk.bold(paddedLabel) : chalk.dim(paddedLabel);
  return `  ${labelText}${value}`;
}

export function renderError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
