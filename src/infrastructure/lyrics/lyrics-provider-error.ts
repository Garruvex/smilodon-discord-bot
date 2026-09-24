export type LyricsSource = "lrclib" | "netease";

// Stable internal codes for everything a lyrics provider can fail with, so
// callers and logs never depend on a provider's own error text or shape.
export type LyricsErrorCode =
  | "timeout"
  | "network"
  | "rate_limited"
  | "http_error"
  | "invalid_response"
  | "provider_error";

export class LyricsProviderError extends Error {
  public constructor(
    public readonly source: LyricsSource,
    public readonly code: LyricsErrorCode,
    // Whether asking again later could plausibly succeed — an outage or a
    // throttle, as opposed to a response we'll never be able to use.
    public readonly retryable: boolean,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LyricsProviderError";
  }
}

// Anything a provider adapter throws that it didn't classify itself (a bug,
// an unexpected library error) still has to come out as a provider error,
// so the caller can treat it as "unavailable" rather than crash.
export function toLyricsProviderError(source: LyricsSource, error: unknown): LyricsProviderError {
  if (error instanceof LyricsProviderError) return error;
  return new LyricsProviderError(source, "provider_error", false, String(error), { cause: error });
}

const requestTimeoutMs = 5_000;

// One HTTP GET + JSON decode, with every failure mode translated into a
// LyricsProviderError.
// `signal` lets a caller cancel a request it no longer needs, on top of the
// per-request timeout.
export async function requestProviderJson(
  source: LyricsSource,
  url: URL,
  options: { readonly headers?: Record<string, string>; readonly signal?: AbortSignal } = {},
): Promise<unknown> {
  const timeout = AbortSignal.timeout(requestTimeoutMs);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, { ...(options.headers ? { headers: options.headers } : {}), signal });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new LyricsProviderError(source, timedOut ? "timeout" : "network", true, String(error), { cause: error });
  }
  if (!response.ok) {
    const throttled = response.status === 429;
    throw new LyricsProviderError(
      source,
      throttled ? "rate_limited" : "http_error",
      throttled || response.status >= 500,
      `HTTP ${response.status}`,
    );
  }
  try {
    return await response.json();
  } catch (error) {
    // Usually an HTML error page from a proxy in front of the API — worth
    // another try later.
    throw new LyricsProviderError(source, "invalid_response", true, "Response was not JSON", { cause: error });
  }
}
