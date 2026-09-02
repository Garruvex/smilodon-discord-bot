const xHosts = new Set(["x.com", "twitter.com", "mobile.twitter.com", "www.x.com", "www.twitter.com"]);
const statusPathPattern = /^\/(\w{1,15})\/status\/(\d+)/;
const fetchTimeoutMs = 8_000;
const mirrors = ["api.vxtwitter.com", "api.fxtwitter.com"];

export interface FetchXPostOptions {
  signal?: AbortSignal;
}

export type FetchXPostResult =
  | { ok: true; finalUrl: string; text: string }
  | { ok: false; reason: string };

interface VxTwitterResponse {
  text?: string;
  user_screen_name?: string;
  user_name?: string;
  likes?: number;
  retweets?: number;
  hashtags?: string[];
  mediaURLs?: string[];
}

export function isXPostUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return xHosts.has(url.hostname.toLowerCase()) && statusPathPattern.test(url.pathname);
}

function parsePathSegments(rawUrl: string): { user: string; id: string } | null {
  const url = new URL(rawUrl);
  const match = statusPathPattern.exec(url.pathname);
  const user = match?.[1];
  const id = match?.[2];
  if (!user || !id || !/^\w{1,15}$/.test(user) || !/^\d+$/.test(id)) return null;
  return { user, id };
}

function summarize(post: VxTwitterResponse, sourceUrl: string): string {
  const author = post.user_name ? `${post.user_name} (@${post.user_screen_name})` : post.user_screen_name ?? "unknown";
  const parts = [
    `Post by ${author}: ${post.text ?? ""}`,
    typeof post.likes === "number" ? `${post.likes} likes` : null,
    typeof post.retweets === "number" ? `${post.retweets} reposts` : null,
    post.hashtags && post.hashtags.length > 0 ? `hashtags: ${post.hashtags.join(", ")}` : null,
    post.mediaURLs && post.mediaURLs.length > 0 ? `media: ${post.mediaURLs.join(", ")}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" | ") || `Post from ${sourceUrl} had no readable text.`;
}

export async function fetchXPost(rawUrl: string, options: FetchXPostOptions = {}): Promise<FetchXPostResult> {
  const segments = parsePathSegments(rawUrl);
  if (!segments) return { ok: false, reason: "that doesn't look like a link to a specific post." };

  for (const mirrorHost of mirrors) {
    const mirrorUrl = `https://${mirrorHost}/${segments.user}/status/${segments.id}`;
    const timeoutSignal = AbortSignal.timeout(fetchTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await fetch(mirrorUrl, { signal, headers: { Accept: "application/json" } });
      if (!response.ok) continue;
      const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
      if (!contentType.includes("application/json")) continue;
      const post = (await response.json()) as VxTwitterResponse;
      if (!post || typeof post !== "object") continue;
      return { ok: true, finalUrl: rawUrl, text: summarize(post, rawUrl) };
    } catch {
      continue;
    }
  }
  return {
    ok: false,
    reason: "it may be deleted, private, or the lookup service is down.",
  };
}
