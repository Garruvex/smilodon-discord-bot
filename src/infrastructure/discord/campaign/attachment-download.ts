// Downloads a file a person uploaded to Discord, for the bot to read as data.
// Only Discord's own attachment hosts, no redirects, a small size cap and a
// short timeout: a message attachment is untrusted input, and this is the one
// door it comes through.

const allowedHosts: ReadonlySet<string> = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const timeoutMs = 10_000;

export type DownloadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "notDiscord" | "tooLarge" | "failed" };

export type BytesResult =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: "notDiscord" | "tooLarge" | "failed" };

export async function downloadAttachmentText(url: string, maxBytes: number): Promise<DownloadResult> {
  const result = await downloadAttachmentBytes(url, maxBytes);
  return result.ok ? { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(result.bytes) } : result;
}

export async function downloadAttachmentBytes(url: string, maxBytes: number): Promise<BytesResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "notDiscord" };
  }
  if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) return { ok: false, reason: "notDiscord" };
  try {
    const response = await fetch(parsed, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok || response.body === null) return { ok: false, reason: "failed" };
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) return { ok: false, reason: "tooLarge" };
    // Read at most the cap, whatever the headers claimed; leaving the loop drops the rest.
    const stream = response.body as unknown as AsyncIterable<Uint8Array>;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of stream) {
      total += chunk.byteLength;
      if (total > maxBytes) return { ok: false, reason: "tooLarge" };
      chunks.push(chunk);
    }
    return { ok: true, bytes: Buffer.concat(chunks) };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
