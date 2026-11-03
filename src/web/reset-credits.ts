export type ResetCredits = {
  available_count: number;
  credits: Array<{
    status: string;
    title: string;
    granted_at: string;
    expires_at: string;
  }>;
};

const cache = new Map<string, Promise<ResetCredits>>();

export function fetchResetCredits(alias: string): Promise<ResetCredits> {
  const cached = cache.get(alias);
  if (cached) return cached;
  const request = requestResetCredits(alias).catch((error: unknown) => {
    cache.delete(alias);
    throw error;
  });
  cache.set(alias, request);
  return request;
}

async function requestResetCredits(alias: string): Promise<ResetCredits> {
  const response = await fetch(
    `/api/reset-credits?alias=${encodeURIComponent(alias)}`,
  );
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message.trim() || `读取 reset credits 失败：${response.status}`);
  }
  return (await response.json()) as ResetCredits;
}

