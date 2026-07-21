import { describe, expect, test } from "bun:test";
import { isPortlessLanIpMismatch } from "../src/ui.ts";

describe("ui portless fallback", () => {
  test("detects LAN IP proxy config mismatch", () => {
    expect(
      isPortlessLanIpMismatch(
        [
          "Proxy is already running on port 1355 with a different config.",
          "- requested LAN IP 192.168.1.8, but the running proxy is using 127.0.0.1",
        ].join("\n"),
      ),
    ).toBe(true);
    expect(isPortlessLanIpMismatch("Failed to start proxy.")).toBe(false);
  });
});
