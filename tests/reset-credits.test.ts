import { expect, test } from "bun:test";
import { fetchResetCredits } from "../src/web/reset-credits.ts";

test("reset credits cache shares requests per account and retries failures", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("retry") && calls.filter((call) => call === url).length === 1) {
      return new Response("unavailable", { status: 503 });
    }
    return Response.json({ available_count: 3, credits: [] });
  }) as typeof fetch;
  try {
    const first = fetchResetCredits("cached");
    expect(fetchResetCredits("cached")).toBe(first);
    await first;
    expect(await fetchResetCredits("cached")).toEqual({ available_count: 3, credits: [] });
    expect(calls).toHaveLength(1);
    await fetchResetCredits("other");
    expect(calls).toHaveLength(2);
    await expect(fetchResetCredits("retry")).rejects.toThrow("unavailable");
    await fetchResetCredits("retry");
    expect(calls).toHaveLength(4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
