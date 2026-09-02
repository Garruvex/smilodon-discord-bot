import * as dns from "node:dns";
import { Agent, fetch as undiciFetch, type Dispatcher, type Response as UndiciResponse } from "undici";

const allowedProtocols = new Set(["http:", "https:"]);
const allowedContentTypePrefixes = ["text/html", "application/xhtml+xml", "text/plain", "application/json"];
const maximumBodyBytes = 1.5 * 1024 * 1024;
const maximumTextLength = 6_000;
const fetchTimeoutMs = 8_000;
const maximumRedirects = 3;

export interface FetchLinkOptions {
  signal?: AbortSignal;
}

export type FetchLinkResult =
  | { ok: true; finalUrl: string; text: string }
  | { ok: false; reason: string };

// Blocks the private/loopback/link-local/reserved ranges a public web-link
// fetcher must never be allowed to reach — these are the addresses an SSRF
// attempt targets (internal services, cloud metadata endpoints, localhost).
function isPrivateAddress(address: string, family: number): boolean {
  if (family === 4) {
    const parts = address.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) return true;
    const [a = 0, b = 0] = parts;
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    return false;
  }
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9")
    || normalized.startsWith("fea") || normalized.startsWith("feb")) return true; // fe80::/10
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateAddress(mapped[1], 4);
  return false;
}

// Rejects the resolved address at actual TCP-connect time (not just during
// the pre-check below), closing the DNS-rebinding gap where a hostname could
// resolve to a public IP during validation and a private one moments later.
//
// undici's Agent always calls this with `{ all: true }` — it expects the
// callback as (err, addresses[]), NOT the single (err, address, family) shape
// dns.lookup defaults to. Getting this wrong doesn't throw a type error, it
// just makes undici silently fail every real request with a useless "fetch
// failed" (see incident: this was the actual reason read_link couldn't read
// any page at all, not the SSRF logic itself).
type LookupAllCallback = (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void;

// Exported only so a test can call it directly with the exact `{ all: true }`
// shape undici's Agent uses — mocking `undici.fetch` wholesale (as the tests
// below do for everything else) never actually exercises this function.
export const guardedLookup: typeof dns.lookup = ((hostname: string, options: unknown, callback?: unknown) => {
  const cb = (typeof options === "function" ? options : callback) as LookupAllCallback;
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return cb(error, []);
    const safeAddresses = addresses.filter((entry) => !isPrivateAddress(entry.address, entry.family));
    if (safeAddresses.length === 0) {
      return cb(new Error(`Refusing to connect to private address for ${hostname}`), []);
    }
    cb(null, safeAddresses);
  });
}) as typeof dns.lookup;

const guardedDispatcher: Dispatcher = new Agent({ connect: { lookup: guardedLookup } });

async function resolveIsPrivate(hostname: string): Promise<boolean> {
  try {
    const { address, family } = await dns.promises.lookup(hostname);
    return isPrivateAddress(address, family);
  } catch {
    return true;
  }
}

function validateUrl(rawUrl: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "that isn't a valid URL." };
  }
  if (!allowedProtocols.has(url.protocol)) {
    return { ok: false, reason: "only http(s) links can be read." };
  }
  return { ok: true, url };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

function extractReadableText(html: string): string {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withoutTags = withoutNoise.replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

function truncate(text: string): string {
  if (text.length <= maximumTextLength) return text;
  return `${text.slice(0, maximumTextLength)} [truncated]`;
}

interface StreamChunk {
  done: boolean;
  value?: Uint8Array;
}

interface StreamReader {
  read(): Promise<StreamChunk>;
  cancel(): Promise<void>;
}

async function readBodyWithCap(response: UndiciResponse): Promise<Buffer | null> {
  const reader = response.body?.getReader() as StreamReader | undefined;
  if (!reader) return Buffer.from(await response.arrayBuffer()).subarray(0, maximumBodyBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    if (!chunk.value) continue;
    total += chunk.value.byteLength;
    if (total > maximumBodyBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks);
}

export async function fetchLinkContent(rawUrl: string, options: FetchLinkOptions = {}): Promise<FetchLinkResult> {
  let target = rawUrl;
  for (let redirectCount = 0; redirectCount <= maximumRedirects; redirectCount++) {
    const validated = validateUrl(target);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    const { url } = validated;

    if (await resolveIsPrivate(url.hostname)) {
      return { ok: false, reason: "that address points to a private or internal network." };
    }

    const timeoutSignal = AbortSignal.timeout(fetchTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;

    let response: UndiciResponse;
    try {
      response = await undiciFetch(url, {
        redirect: "manual",
        signal,
        dispatcher: guardedDispatcher,
        headers: { Accept: "text/html,application/xhtml+xml,text/plain,application/json" },
      });
    } catch {
      return { ok: false, reason: "the request failed or timed out." };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: `the server returned a redirect with no destination.` };
      target = new URL(location, url).toString();
      continue;
    }

    if (!response.ok) {
      return { ok: false, reason: `the server responded with status ${response.status}.` };
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!allowedContentTypePrefixes.some((prefix) => contentType.startsWith(prefix))) {
      return { ok: false, reason: `unsupported content type (${contentType || "unknown"}).` };
    }

    const body = await readBodyWithCap(response);
    if (body === null) return { ok: false, reason: "the page was too large to read." };

    const rawText = body.toString("utf-8");
    const text = contentType.startsWith("text/html") || contentType.startsWith("application/xhtml+xml")
      ? extractReadableText(rawText)
      : rawText.trim();

    if (!text) return { ok: false, reason: "no readable text was found on that page." };
    return { ok: true, finalUrl: url.toString(), text: truncate(text) };
  }
  return { ok: false, reason: "too many redirects." };
}
