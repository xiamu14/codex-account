import { describe, expect, test } from "bun:test";
import path from "node:path";
import { buildServices } from "../src/launchd.ts";

describe("launchd services", () => {
  test("runs the UI server directly without managing the proxy", () => {
    const projectRoot = "/tmp/codex-account";
    const webService = buildServices(projectRoot).find((service) =>
      service.label === "com.codex-account.web",
    );
    expect(webService?.programArguments).toEqual([
      process.execPath,
      path.join(projectRoot, "src", "main.ts"),
      "ui",
      "--serve",
    ]);
  });
});
