import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attachment } from "discord.js";
import type { Logger } from "pino";
import { ChatTurnSupport } from "../../src/infrastructure/discord/behaviors/chat-turn-support.js";

afterEach(() => vi.unstubAllGlobals());
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
function attachment(url = "https://cdn.discordapp.com/attachments/1/2/image.png"): Attachment {
  return { id: "2", url, contentType: "image/png", size: png.length } as Attachment;
}
function support(): ChatTurnSupport { return new ChatTurnSupport({ warn: vi.fn() } as unknown as Logger); }

describe("authorized attachment downloader", () => {
  it("accepts a bounded Discord image and forbids redirect following", async () => {
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return Promise.resolve(new Response(png, { status: 200 }));
    });
    vi.stubGlobal("fetch", fetch);
    const result = await support().loadImages([{ attachment: attachment(), source: "current_message", sourceIndex: 0 }]);
    expect(result.images[0]?.dataUrl).toBe(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);
  });
  it("rejects a non-Discord host before sending any request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const result = await support().loadImages([{ attachment: attachment("http://127.0.0.1/private"), source: "current_message", sourceIndex: 0 }]);
    expect(result.images).toEqual([]); expect(fetch).not.toHaveBeenCalled();
  });
  it("cancels an oversized stream before buffering an unbounded response", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller): void { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); }, cancel });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(body, { status: 200 }))));
    const result = await support().loadImages([{ attachment: attachment(), source: "current_message", sourceIndex: 0 }]);
    expect(result.images).toEqual([]); expect(cancel).toHaveBeenCalledOnce();
  });
});
