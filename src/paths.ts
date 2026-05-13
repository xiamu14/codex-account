import { homedir } from 'node:os';
import path from 'node:path';

export function resolveAppHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CXA_HOME?.trim() || path.join(homedir(), '.codex-account');
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || path.join(homedir(), '.codex');
}

export function accountsStatePath(appHome: string): string {
  return path.join(appHome, 'accounts.json');
}

export function accountsRoot(appHome: string): string {
  return path.join(appHome, 'accounts');
}

export function accountHome(appHome: string, alias: string): string {
  return path.join(accountsRoot(appHome), alias);
}

export function accountAuthPath(appHome: string, alias: string): string {
  return path.join(accountHome(appHome, alias), 'auth.json');
}

export function accountMetaPath(appHome: string, alias: string): string {
  return path.join(accountHome(appHome, alias), 'meta.json');
}

export function accountQuotaPath(appHome: string, alias: string): string {
  return path.join(accountHome(appHome, alias), 'quota.json');
}

export function autoQuotaStatePath(appHome: string): string {
  return path.join(appHome, 'auto-quota.json');
}

export function runsRoot(appHome: string): string {
  return path.join(appHome, 'runs');
}

export function lockPath(appHome: string): string {
  return path.join(appHome, 'lock');
}
