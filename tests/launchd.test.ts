import { describe, expect, test } from "bun:test";
import path from "node:path";
import { buildServices } from "../src/launchd.ts";

describe("launchd services", () => {
  test("runs portless through Bun instead of the node shebang wrapper", () => {
    const projectRoot = "/tmp/codex-account";
    const [webService] = buildServices(projectRoot);

    expect(webService?.programArguments.slice(0, 2)).toEqual([
      process.execPath,
      path.join(projectRoot, "node_modules", "portless", "dist", "cli.js"),
    ]);
    expect(webService?.programArguments).toContain(
      path.join(projectRoot, "src", "main.ts"),
    );
    expect(webService?.programArguments).not.toContain(
      path.join(projectRoot, "node_modules", ".bin", "portless"),
    );
  });
});
