import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

const UI_APP_PORT = 41_739;
const VITE_DEV_PORT = 41_740;
const PORTLESS_PROXY_PORT = 1_355;
const PORTLESS_NAME = "codexaccount";
const projectRoot = path.resolve(import.meta.dir, "..", "..");
const children: ChildProcess[] = [];
let shuttingDown = false;

function run(label: string, command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORTLESS_HTTPS: "0",
      PORTLESS_PORT: String(PORTLESS_PROXY_PORT),
    },
    stdio: "inherit",
  });
  children.push(child);
  child.once("exit", (code, signal) => {
    if (shuttingDown) return;
    shutdown();
    if (code !== 0 && signal === null) {
      process.stderr.write(`${label} 已退出：${code}\n`);
      process.exitCode = code ?? 1;
    }
  });
  child.once("error", (error) => {
    if (shuttingDown) return;
    shutdown();
    process.stderr.write(`${label} 启动失败：${error.message}\n`);
    process.exitCode = 1;
  });
  return child;
}

function shutdown(): void {
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

process.once("SIGINT", () => {
  shutdown();
  process.exitCode = 130;
});
process.once("SIGTERM", () => {
  shutdown();
  process.exitCode = 143;
});

const portlessEntrypoint = path.join(
  projectRoot,
  "node_modules",
  "portless",
  "dist",
  "cli.js",
);
const publicUrl = `http://${PORTLESS_NAME}.localhost:${PORTLESS_PROXY_PORT}`;

run("Hono UI 服务", process.execPath, ["run", "src/main.ts", "ui", "--serve"]);
run("Tailwind", process.execPath, [
  "run",
  "tailwindcss",
  "-i",
  "src/web/globals.css",
  "-o",
  "src/web/static/alignui.css",
  "--watch",
]);
run("Portless + Vite", process.execPath, [
  portlessEntrypoint,
  PORTLESS_NAME,
  "--app-port",
  String(VITE_DEV_PORT),
  "--",
  process.execPath,
  "run",
  "vite",
  "--host",
  "127.0.0.1",
  "--port",
  String(VITE_DEV_PORT),
  "--strictPort",
]);

process.stdout.write(
  [
    `Web UI 开发服务已启动：${publicUrl}`,
    `Hono API：http://127.0.0.1:${UI_APP_PORT}`,
    `Vite：http://127.0.0.1:${VITE_DEV_PORT}`,
  ].join("\n") + "\n",
);
