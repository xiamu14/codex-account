import { describe, expect, test } from "bun:test";
import { parseAuthAccountInfo } from "../src/auth-jwt.ts";

describe("auth JWT account info", () => {
  test("parses plan and subscription expiry from id token payload", () => {
    const account = parseAuthAccountInfo({
      tokens: {
        id_token: makeJwt({
          email: "user@example.com",
          "https://api.openai.com/auth": {
            chatgpt_plan_type: "plus",
            chatgpt_subscription_active_start: "2026-05-15T11:52:11+00:00",
            chatgpt_subscription_active_until: "2026-06-15T11:52:11+00:00",
            chatgpt_subscription_last_checked: "2026-05-30T06:17:26.250714+00:00",
          },
        }),
      },
    });

    expect(account).toEqual({
      email: "user@example.com",
      planType: "plus",
      subscriptionExpiresAt: "2026-06-15T11:52:11.000Z",
    });
  });

  test("ignores auth files without an id token", () => {
    expect(parseAuthAccountInfo({ token: "legacy" })).toBeNull();
  });

  test("keeps expired subscription claims for stale-date warnings", () => {
    const account = parseAuthAccountInfo({
      tokens: {
        id_token: makeJwt({
          email: "user@example.com",
          "https://api.openai.com/auth": {
            chatgpt_plan_type: "plus",
            chatgpt_subscription_active_until: "2026-05-15T08:58:28+00:00",
          },
        }),
      },
    });

    expect(account).toEqual({
      email: "user@example.com",
      planType: "plus",
      subscriptionExpiresAt: "2026-05-15T08:58:28.000Z",
    });
  });
});

function makeJwt(payload: unknown): string {
  return [
    encodeBase64Url({ alg: "none", typ: "JWT" }),
    encodeBase64Url(payload),
    "",
  ].join(".");
}

function encodeBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
