import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadAttachmentText } from "../../../../src/infrastructure/discord/campaign/attachment-download.js";

afterEach(() => vi.unstubAllGlobals());

function respond(body: string, headers: Record<string, string> = {}): void {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { headers })));
}

describe("downloading an attachment", () => {
  it("reads a small file from Discord's own host", async () => {
    respond("hello 世界");
    expect(await downloadAttachmentText("https://cdn.discordapp.com/attachments/1/2/file.json", 100)).toEqual({ ok: true, text: "hello 世界" });
  });

  it("refuses any other host or scheme without fetching", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    for (const url of ["https://evil.example/file.json", "http://cdn.discordapp.com/file.json", "https://cdn.discordapp.com.evil.example/x", "file:///etc/passwd", "not a url", "https://127.0.0.1/x"]) {
      expect(await downloadAttachmentText(url, 100), url).toEqual({ ok: false, reason: "notDiscord" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("stops at the size cap, whatever the headers say", async () => {
    respond("x".repeat(500), { "content-length": "10" });
    expect(await downloadAttachmentText("https://media.discordapp.net/a", 100)).toEqual({ ok: false, reason: "tooLarge" });
    respond("small", { "content-length": "9999" });
    expect(await downloadAttachmentText("https://media.discordapp.net/a", 100)).toEqual({ ok: false, reason: "tooLarge" });
  });

  it("reports a failed request, a bad status and a redirect as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network")));
    expect(await downloadAttachmentText("https://cdn.discordapp.com/a", 100)).toEqual({ ok: false, reason: "failed" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 404 })));
    expect(await downloadAttachmentText("https://cdn.discordapp.com/a", 100)).toEqual({ ok: false, reason: "failed" });
  });

  it("does not follow a redirect", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("x"));
    vi.stubGlobal("fetch", fetcher);
    await downloadAttachmentText("https://cdn.discordapp.com/a", 100);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });
});
