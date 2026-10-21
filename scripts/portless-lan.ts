import { networkInterfaces } from "node:os";
import path from "node:path";

const APP_NAME = "codexaccount";
const APP_PORT = "41739";
const PROXY_PORT = process.env.PORTLESS_PORT ?? "1355";
const projectRoot = path.resolve(import.meta.dir, "..");
const lanIp = process.env.PORTLESS_LAN_IP ?? detectLanIp();
if (!lanIp) {
  throw new Error("未找到 LAN IPv4 地址，请设置 PORTLESS_LAN_IP 后重试。");
}
const env: NodeJS.ProcessEnv = {
  ...process.env,
  PORTLESS_HTTPS: "0",
  PORTLESS_LAN: "1",
  PORTLESS_LAN_IP: lanIp,
  PORTLESS_PORT: PROXY_PORT,
};
delete env.PORTLESS_STATE_DIR;

await runPortless(["proxy", "stop", "-p", PROXY_PORT]);
await runPortless(["proxy", "start", "--no-tls", "--lan", "--ip", lanIp, "-p", PROXY_PORT]);
await runPortless(["alias", APP_NAME, APP_PORT, "--force"]);
await syncHosts();

const app = Bun.spawn(
  [process.execPath, path.join(projectRoot, "src/main.ts"), "ui", "--serve"],
  { cwd: projectRoot, env, stdout: "inherit", stderr: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => app.kill(signal));
}
process.exit(await app.exited);

async function runPortless(args: string[]): Promise<void> {
  const proc = Bun.spawn(["portless", ...args], {
    cwd: projectRoot,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`portless ${args.join(" ")} exited with code ${code}`);
  }
}

async function syncHosts(): Promise<void> {
  if (!(await Bun.file("/etc/hosts").text()).includes(`${APP_NAME}.local`)) {
    await runPortless(["hosts", "sync"]);
  }
}

function detectLanIp(): string | undefined {
  const addresses = Object.values(networkInterfaces())
    .flatMap((items) => items ?? [])
    .filter((item) => item.family === "IPv4" && !item.internal)
    .map((item) => item.address);
  return addresses.find(isPrivateLanIp) ?? addresses[0];
}

function isPrivateLanIp(address: string): boolean {
  if (address.startsWith("10.")) return true;
  if (address.startsWith("192.168.")) return true;
  const match = /^172\.(\d+)\./.exec(address);
  return match !== null && Number(match[1]) >= 16 && Number(match[1]) <= 31;
}
