import { describe, expect, test } from "bun:test";
import path from "node:path";
import { buildServices, selectPortlessLanIp } from "../src/launchd.ts";

describe("launchd services", () => {
  test("runs the UI launcher so portless fallback can apply", () => {
    const projectRoot = "/tmp/codex-account";
    const webService = buildServices(projectRoot).find((service) =>
      service.programArguments.includes("ui"),
    );

    expect(webService?.programArguments).toEqual([
      process.execPath,
      path.join(projectRoot, "src", "main.ts"),
      "ui",
    ]);
    expect(webService?.programArguments).not.toContain(
      path.join(projectRoot, "node_modules", ".bin", "portless"),
    );
    expect(webService?.programArguments).not.toContain(
      path.join(projectRoot, "node_modules", "portless", "dist", "cli.js"),
    );
  });

  test("prefers a private IPv4 address for portless LAN mode", () => {
    expect(
      selectPortlessLanIp({
        lo0: [
          {
            address: "127.0.0.1",
            netmask: "255.0.0.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: true,
            cidr: "127.0.0.1/8",
          },
        ],
        utun0: [
          {
            address: "198.18.0.1",
            netmask: "255.255.255.252",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: false,
            cidr: "198.18.0.1/30",
          },
        ],
        en1: [
          {
            address: "192.168.1.8",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "0e:36:7e:6d:0a:de",
            internal: false,
            cidr: "192.168.1.8/24",
          },
        ],
      }),
    ).toBe("192.168.1.8");
  });
});
