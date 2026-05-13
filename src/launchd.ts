import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathExists, removePath } from "./fs.ts";
import { AUTO_QUOTA_INTERVAL_MINUTES } from "./auto-quota.ts";

const execFileAsync = promisify(execFile);
const LABEL = "com.codex-account.auto-quota";

export function launchAgentPath(home: string = homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

export async function isAutoQuotaLaunchAgentInstalled(): Promise<boolean> {
  return pathExists(launchAgentPath());
}

export async function installAutoQuotaLaunchAgent(options: {
  bunBin: string;
  scriptPath: string;
  cwd: string;
  appHome: string;
  codexHome: string;
  codexBin: string;
}): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("自动后台任务目前只支持 macOS。");
  }

  const plistPath = launchAgentPath();
  await mkdir(path.dirname(plistPath), { recursive: true });
  await writeFile(plistPath, renderPlist(options), "utf8");
  await execFileAsync("launchctl", ["unload", plistPath]).catch(() => undefined);
  await execFileAsync("launchctl", ["load", plistPath]);
}

export async function uninstallAutoQuotaLaunchAgent(): Promise<void> {
  if (process.platform !== "darwin") return;
  const plistPath = launchAgentPath();
  await execFileAsync("launchctl", ["unload", plistPath]).catch(() => undefined);
  await removePath(plistPath);
}

function renderPlist(options: {
  bunBin: string;
  scriptPath: string;
  cwd: string;
  appHome: string;
  codexHome: string;
  codexBin: string;
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.bunBin)}</string>
    <string>${escapeXml(options.scriptPath)}</string>
    <string>quota</string>
    <string>--tick</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(options.cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CXA_HOME</key>
    <string>${escapeXml(options.appHome)}</string>
    <key>CODEX_HOME</key>
    <string>${escapeXml(options.codexHome)}</string>
    <key>CXA_CODEX_BIN</key>
    <string>${escapeXml(options.codexBin)}</string>
  </dict>
  <key>StartInterval</key>
  <integer>${AUTO_QUOTA_INTERVAL_MINUTES * 60}</integer>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

