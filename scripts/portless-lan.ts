import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "..");
const app = Bun.spawn(
  [process.execPath, path.join(projectRoot, "src/main.ts"), "ui", "--serve"],
  { cwd: projectRoot, env: process.env, stdout: "inherit", stderr: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => app.kill(signal));
}
process.exit(await app.exited);
