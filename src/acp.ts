import { spawn } from 'node:child_process';
import type { AcpAccountInfo, AcpBestEffortSnapshot, AcpSnapshot, AccountQuota, LimitStatus } from './types.ts';
import { isNumber, isRecord, isString } from './guards.ts';

type JsonRpcMessage = {
  id?: number;
  result?: unknown;
  error?: unknown;
};

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (!isRecord(value)) return false;
  return (value.id === undefined || isNumber(value.id)) && ('result' in value || 'error' in value);
}

function parseJsonLines(output: string): JsonRpcMessage[] {
  const messages: JsonRpcMessage[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isJsonRpcMessage(parsed)) {
        messages.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return messages;
}

function methodCall(id: number, method: string): string {
  const params = method === 'initialize' ? {
    clientInfo: {
      name: 'cxa',
      title: 'Codex Account CLI',
      version: '0.1.0'
    },
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: []
    }
  } : method === 'account/read' ? {
    refreshToken: false
  } : undefined;

  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params
  });
}

export async function readAcpSnapshot(codexBin: string, codexHome: string, cwd: string): Promise<AcpSnapshot> {
  const snapshot = await readAcpSnapshotBestEffort(codexBin, codexHome, cwd);
  if (snapshot.quota === null) {
    throw new Error(snapshot.quotaError ?? 'ACP 读取额度信息失败');
  }
  return {
    account: snapshot.account,
    quota: snapshot.quota
  };
}

export async function readAcpSnapshotBestEffort(
  codexBin: string,
  codexHome: string,
  cwd: string
): Promise<AcpBestEffortSnapshot> {
  const output = await runAppServerRequests(codexBin, codexHome, cwd, [
    methodCall(2, 'account/read'),
    methodCall(3, 'account/rateLimits/read')
  ], [2, 3]);
  const messages = parseJsonLines(output);
  const accountMessage = messages.find((message) => message.id === 2);
  const quotaMessage = messages.find((message) => message.id === 3);

  if (!accountMessage || accountMessage.error !== undefined) {
    throw new Error(formatAcpFailure('ACP 读取账号信息失败', output, accountMessage));
  }

  const account = parseAccountInfo(accountMessage.result);
  if (!quotaMessage || quotaMessage.error !== undefined) {
    return {
      account,
      quota: null,
      quotaError: formatAcpFailure('ACP 读取额度信息失败', output, quotaMessage)
    };
  }

  return {
    account,
    quota: parseQuota(quotaMessage.result),
    quotaError: null
  };
}

export async function readAcpAccount(codexBin: string, codexHome: string, cwd: string): Promise<AcpAccountInfo> {
  const output = await runAppServerRequests(codexBin, codexHome, cwd, [
    methodCall(2, 'account/read')
  ], [2]);
  const message = parseJsonLines(output).find((item) => item.id === 2);
  if (!message || message.error !== undefined) {
    throw new Error(formatAcpFailure('ACP 读取账号信息失败', output, message));
  }
  return parseAccountInfo(message.result);
}

async function runAppServerRequests(
  codexBin: string,
  codexHome: string,
  cwd: string,
  requests: string[],
  expectedIds: number[]
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(codexBin, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env: {
        ...process.env,
        CODEX_HOME: codexHome
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const seenIds = new Set<number>();
    let settled = false;
    let initialized = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      const output = Buffer.concat([...chunks, ...errors]).toString('utf8');
      reject(new Error(output.trim() || 'codex app-server 等待 ACP 响应超时。'));
    }, 10_000);

    function finish(result: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      result();
    }

    child.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      const output = Buffer.concat(chunks).toString('utf8');
      const messages = parseJsonLines(output);
      for (const message of messages) {
        if (message.id !== undefined) {
          seenIds.add(message.id);
        }
      }
      if (!initialized && seenIds.has(1)) {
        initialized = true;
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
        for (const request of requests) {
          child.stdin.write(`${request}\n`);
        }
      }
      if (expectedIds.every((id) => seenIds.has(id))) {
        setTimeout(() => {
          child.stdin.end();
        }, 100);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
    child.on('error', (error) => {
      finish(() => reject(error));
    });
    child.on('exit', (code) => {
      const output = Buffer.concat([...chunks, ...errors]).toString('utf8');
      if (code === 0 || output.includes('"id":2') || output.includes('"id":3')) {
        finish(() => resolve(output));
      } else {
        finish(() => reject(new Error(output.trim() || `codex app-server 退出码 ${code ?? 'unknown'}，但没有输出。`)));
      }
    });

    child.stdin.write(`${methodCall(1, 'initialize')}\n`);
  });
}

function formatAcpFailure(title: string, output: string, message: JsonRpcMessage | undefined): string {
  const details: string[] = [title];
  if (message === undefined) {
    details.push('原因：没有收到对应 id 的 ACP 响应。');
  } else if (message.error !== undefined) {
    details.push(`ACP error：${stringifyUnknown(message.error)}`);
  } else {
    details.push(`响应内容无法识别：${stringifyUnknown(message)}`);
  }

  const trimmed = output.trim();
  if (trimmed.length > 0) {
    details.push('原始输出：');
    details.push(trimmed);
  } else {
    details.push('原始输出为空。');
  }
  return details.join('\n');
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function parseAccountInfo(value: unknown): AcpAccountInfo {
  const root = isRecord(value) ? value : {};
  const account = isRecord(root.account) ? root.account : root;
  const email = pickString(account, ['email', 'accountEmail']);
  const planType = pickString(account, ['planType', 'plan', 'subscriptionPlan']);
  const subscriptionExpiresAt = pickString(account, ['subscriptionExpiresAt', 'expiresAt', 'renewalDate']);
  return {
    email,
    planType,
    subscriptionExpiresAt
  };
}

export function parseQuota(value: unknown): AccountQuota {
  const root = isRecord(value) ? value : {};
  const rateLimits = selectCodexRateLimits(root);
  return {
    fiveHour: parseLimit(pickRecord(rateLimits, ['fiveHour', 'five_hour', '5h', 'fiveHourLimit', 'primary']) ?? findLimitByName(rateLimits, '5h')),
    weekly: parseLimit(pickRecord(rateLimits, ['weekly', 'week', 'weeklyLimit', 'secondary']) ?? findLimitByName(rateLimits, 'weekly')),
    updatedAt: new Date().toISOString()
  };
}

function parseLimit(value: unknown): LimitStatus | null {
  if (!isRecord(value)) return null;
  const explicitLeft = pickNumber(value, ['percentLeft', 'remainingPercent', 'remaining_percentage', 'remaining']);
  const usedPercent = pickNumber(value, ['usedPercent', 'used_percentage', 'used']);
  const percentLeft = explicitLeft ?? (usedPercent === null ? null : Math.max(0, Math.min(100, 100 - usedPercent)));
  const resetEpoch = pickNumber(value, ['resetsAt', 'resetAt', 'resets_at']);
  const resetsAt = pickString(value, ['resetsAt', 'resetAt', 'resets_at']) ?? (resetEpoch === null ? null : new Date(resetEpoch * 1000).toISOString());
  const rawReset = pickString(value, ['rawReset', 'reset', 'resetText', 'displayReset']) ?? resetsAt;
  return { percentLeft, resetsAt, rawReset };
}

function selectCodexRateLimits(root: Record<string, unknown>): Record<string, unknown> {
  const byLimitId = root.rateLimitsByLimitId;
  if (isRecord(byLimitId)) {
    const codex = byLimitId.codex;
    if (isRecord(codex)) return codex;
  }
  const rateLimits = root.rateLimits;
  return isRecord(rateLimits) ? rateLimits : root;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (isString(value) && value.trim().length > 0) return value;
  }
  return null;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (isNumber(value)) return value;
    if (isString(value)) {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function pickRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) return value;
  }
  return null;
}

function findLimitByName(record: Record<string, unknown>, name: string): Record<string, unknown> | null {
  for (const value of Object.values(record)) {
    if (!isRecord(value)) continue;
    const label = pickString(value, ['name', 'label', 'type']);
    if (label?.toLowerCase().includes(name)) {
      return value;
    }
  }
  return null;
}
