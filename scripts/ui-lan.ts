import { networkInterfaces } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { selectPortlessLanIp } from "../src/launchd.ts";

const APP_NAME = "codexaccount";
const APP_PORT = "41739";
const PROXY_PORT = process.env.PORTLESS_PORT ?? "1355";
const projectRoot = path.resolve(import.meta.dir, "..");
const stateDir = path.join(projectRoot, ".runtime", "portless");
const lanIp = process.env.PORTLESS_LAN_IP ?? selectPortlessLanIp(networkInterfaces());
const env = {
  ...process.env,
  PORTLESS_HTTPS: process.env.PORTLESS_HTTPS ?? "0",
  PORTLESS_LAN: "1",
  PORTLESS_PORT: PROXY_PORT,
  PORTLESS_STATE_DIR: stateDir,
  ...(lanIp ? { PORTLESS_LAN_IP: lanIp } : {}),
};

await runPortless(["proxy", "stop", "-p", PROXY_PORT], process.env, true);
await runPortless(
  [
    "proxy",
    "start",
    "--no-tls",
    "--lan",
    ...(lanIp ? ["--ip", lanIp] : []),
    "-p",
    PROXY_PORT,
  ],
  env,
);
await runPortless(["alias", APP_NAME, APP_PORT, "--force"], env);

const child = spawn(process.execPath, [path.join(projectRoot, "src/main.ts"), "ui", "--serve"], {
  cwd: projectRoot,
  env,
  stdio: "inherit",
});

const stop = () => child.kill("SIGTERM");
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

child.once("error", (error) => {
  console.error(`Web UI 启动失败：${error.message}`);
  process.exitCode = 1;
});

const exitCode = await new Promise<number>((resolve) => {
  child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGTERM" ? 0 : 1)));
});
process.exitCode = exitCode;

function runPortless(
  args: string[],
  commandEnv: NodeJS.ProcessEnv,
  allowFailure = false,
): Promise<void> {
  const child = spawn("portless", args, {
    cwd: projectRoot,
    env: commandEnv,
    stdio: "inherit",
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0 || allowFailure) {
        resolve();
        return;
      }
      reject(new Error(`portless ${args.join(" ")} exited with code ${code}`));
    });
  });
}
