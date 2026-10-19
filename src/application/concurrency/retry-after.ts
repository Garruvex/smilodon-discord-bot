// Inspect only numeric retry metadata; never log arbitrary error payloads.
export function retryAfterMs(error: unknown): number | null {
  try {
    if (!error || typeof error !== "object") return null;
    const value = error as { retryAfter?: unknown; retry_after?: unknown; rawError?: { retry_after?: unknown } };
    const milliseconds = value.retryAfter;
    const seconds = value.retry_after ?? value.rawError?.retry_after;
    const valid = (number: unknown): number is number => typeof number === "number" && Number.isFinite(number) && number >= 0;
    const waits = [...(valid(milliseconds) ? [milliseconds] : []), ...(valid(seconds) && Number.isFinite(seconds * 1000) ? [seconds * 1000] : [])];
    return waits.length ? Math.max(...waits) : null;
  } catch { return null; }
}
