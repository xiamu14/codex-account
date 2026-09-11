import { describe, expect, test } from "bun:test";
import path from "node:path";
import { buildServices } from "../src/launchd.ts";

describe("launchd services", () => {
  test("runs the independent LAN UI launcher", () => {
    const projectRoot = "/tmp/codex-account";
    const webService = buildServices(projectRoot).find((service) =>
      service.programArguments.some((argument) => argument.endsWith("/portless-lan.ts")),
    );

    expect(webService?.programArguments).toEqual([
      process.execPath,
      path.join(projectRoot, "scripts", "portless-lan.ts"),
    ]);
    expect(webService?.programArguments).not.toContain(
      path.join(projectRoot, "node_modules", ".bin", "portless"),
    );
    expect(webService?.programArguments).not.toContain(
      path.join(projectRoot, "node_modules", "portless", "dist", "cli.js"),
    );
  });
});
