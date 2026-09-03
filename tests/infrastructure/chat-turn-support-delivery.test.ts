import type { Message } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { ChatTurnSupport, type ChatDeliveryPayload } from "../../src/infrastructure/discord/behaviors/chat-turn-support.js";
import type { GeneratedChatImage } from "../../src/application/chat/chat-provider.js";

function logger(): Logger {
  return { warn: vi.fn() } as unknown as Logger;
}

function fakeMessage(id: string): Message {
  return { id } as unknown as Message;
}

function image(bytes: number, filename = "image.png"): GeneratedChatImage {
  return { data: Buffer.alloc(bytes), contentType: "image/png", filename };
}

const oneMiB = 1024 * 1024;

describe("ChatTurnSupport.deliverChatResponse", () => {
  it("sends a short reply as a single message via the first-sender", async () => {
    const support = new ChatTurnSupport(logger());
    const first = vi.fn(() => Promise.resolve(fakeMessage("1")));
    const rest = vi.fn(() => Promise.resolve(fakeMessage("2")));

    const result = await support.deliverChatResponse({
      sender: { first, rest },
      text: "Hello there.",
      sources: [],
      images: [],
      emptyFallbackContent: "I ran out of words.",
      maxImageAggregateBytes: 10 * oneMiB,
    });

    expect(first).toHaveBeenCalledExactlyOnceWith({ content: "Hello there.", files: [] });
    expect(rest).not.toHaveBeenCalled();
    expect(result.deliveredText).toBe("Hello there.");
  });

  it("sends multiple chunks sequentially: first via the preview/reply sender, the rest via the plain sender", async () => {
    const support = new ChatTurnSupport(logger());
    const calls: string[] = [];
    const first = vi.fn((payload: { content: string }) => {
      calls.push(`first:${payload.content.length}`);
      return Promise.resolve(fakeMessage("1"));
    });
    const rest = vi.fn((payload: { content: string }) => {
      calls.push(`rest:${payload.content.length}`);
      return Promise.resolve(fakeMessage("2"));
    });
    const text = "word ".repeat(900).trim(); // long enough to need 3 chunks, short of the 8,000-char attachment fallback

    await support.deliverChatResponse({
      sender: { first, rest },
      text,
      sources: [],
      images: [],
      emptyFallbackContent: "I ran out of words.",
      maxImageAggregateBytes: 10 * oneMiB,
    });

    expect(first).toHaveBeenCalledTimes(1);
    expect(rest.mock.calls.length).toBeGreaterThan(0);
    expect(calls[0]!.startsWith("first:")).toBe(true);
    expect(calls.slice(1).every((call) => call.startsWith("rest:"))).toBe(true);
  });

  it("falls back to a fallback message when the reply text and images are both empty", async () => {
    const support = new ChatTurnSupport(logger());
    const first = vi.fn(() => Promise.resolve(fakeMessage("1")));

    await support.deliverChatResponse({
      sender: { first, rest: vi.fn() },
      text: "",
      sources: [],
      images: [],
      emptyFallbackContent: "I ran out of words.",
      maxImageAggregateBytes: 10 * oneMiB,
    });

    expect(first).toHaveBeenCalledExactlyOnceWith({ content: "I ran out of words.", files: [] });
  });

  it("uses the empty-fallback content as the caption for an image-only reply", async () => {
    const support = new ChatTurnSupport(logger());
    const first = vi.fn((_payload: ChatDeliveryPayload) => Promise.resolve(fakeMessage("1")));
    const img = image(oneMiB);

    await support.deliverChatResponse({
      sender: { first, rest: vi.fn() },
      text: "",
      sources: [],
      images: [img],
      emptyFallbackContent: "Here you go!",
      maxImageAggregateBytes: 10 * oneMiB,
    });

    // Reference-checked rather than deep-equal — comparing large Buffers
    // structurally is needlessly slow, and identity is exactly what matters
    // here (the same data must reach Discord unmodified).
    expect(first).toHaveBeenCalledTimes(1);
    const payload = first.mock.calls[0]![0];
    expect(payload.content).toBe("Here you go!");
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]!.attachment).toBe(img.data);
    expect(payload.files[0]!.name).toBe(img.filename);
  });

  it("attaches a small image group to the already-planned final text message instead of sending it separately", async () => {
    const support = new ChatTurnSupport(logger());
    const first = vi.fn((_payload: ChatDeliveryPayload) => Promise.resolve(fakeMessage("1")));
    const rest = vi.fn(() => Promise.resolve(fakeMessage("2")));
    const img = image(oneMiB);

    await support.deliverChatResponse({
      sender: { first, rest },
      text: "Here's your image.",
      sources: [],
      images: [img],
      emptyFallbackContent: "Here you go!",
      maxImageAggregateBytes: 10 * oneMiB,
    });

    expect(first).toHaveBeenCalledTimes(1);
    const payload = first.mock.calls[0]![0];
    expect(payload.content).toBe("Here's your image.");
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]!.attachment).toBe(img.data);
    expect(rest).not.toHaveBeenCalled();
  });

  it("splits generated images into separate follow-up messages once they exceed the aggregate byte cap", async () => {
    const support = new ChatTurnSupport(logger());
    const first = vi.fn((_payload: ChatDeliveryPayload) => Promise.resolve(fakeMessage("1")));
    const rest = vi.fn((_payload: ChatDeliveryPayload) => Promise.resolve(fakeMessage("2")));
    // Small synthetic sizes, not real MiB-scale ones — the actual byte-cap
    // arithmetic is already covered by chat-image-delivery.test.ts; this
    // test only needs to check that deliverChatResponse wires multiple
    // planImageDelivery groups into separate sends. (Large Buffers flowing
    // through vi.fn()'s call-argument tracking is pathologically slow in
    // this environment — comparing/holding multi-MB buffers there, not the
    // delivery logic itself, is what made this test time out before.)
    const images = [image(15), image(15)];

    await support.deliverChatResponse({
      sender: { first, rest },
      text: "Here you go!",
      sources: [],
      images,
      emptyFallbackContent: "Here you go!",
      maxImageAggregateBytes: 20,
    });

    // One image rides with the text message, the other becomes a follow-up.
    expect(first).toHaveBeenCalledTimes(1);
    const firstPayload = first.mock.calls[0]![0];
    expect(firstPayload.content).toBe("Here you go!");
    expect(firstPayload.files).toHaveLength(1);
    expect(firstPayload.files[0]!.attachment).toBe(images[0]!.data);

    expect(rest).toHaveBeenCalledTimes(1);
    const restPayload = rest.mock.calls[0]![0];
    expect(restPayload.content).toBe("");
    expect(restPayload.files).toHaveLength(1);
    expect(restPayload.files[0]!.attachment).toBe(images[1]!.data);
  });

  it("reports an image that could never fit within the aggregate cap instead of silently dropping it", async () => {
    const support = new ChatTurnSupport(logger());
    const first = vi.fn((_payload: ChatDeliveryPayload) => Promise.resolve(fakeMessage("1")));
    const rest = vi.fn((_payload: ChatDeliveryPayload) => Promise.resolve(fakeMessage("2")));
    const tooLarge = image(50 * oneMiB, "huge.png");

    await support.deliverChatResponse({
      sender: { first, rest },
      text: "Here you go!",
      sources: [],
      images: [tooLarge],
      emptyFallbackContent: "Here you go!",
      maxImageAggregateBytes: 10 * oneMiB,
    });

    expect(first).toHaveBeenCalledTimes(1);
    const payload = first.mock.calls[0]![0];
    expect(payload.content).toContain("couldn't be delivered");
    expect(payload.files).toEqual([]);
  });

  it("falls back to a .txt attachment for a reply too long to chunk, delivered via the first sender", async () => {
    const support = new ChatTurnSupport(logger());
    const first = vi.fn((_payload: ChatDeliveryPayload) => Promise.resolve(fakeMessage("1")));
    const longText = "word ".repeat(2_000).trim();

    await support.deliverChatResponse({
      sender: { first, rest: vi.fn() },
      text: longText,
      sources: [],
      images: [],
      emptyFallbackContent: "I ran out of words.",
      maxImageAggregateBytes: 10 * oneMiB,
    });

    expect(first).toHaveBeenCalledTimes(1);
    const payload = first.mock.calls[0]![0];
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]!.attachment.toString("utf8")).toBe(longText);
  });

  // Real timers (not vi.useFakeTimers) — the retry backoff is short
  // (well under a second total), and faking it introduced a flaky
  // interaction with Vitest's own timeout machinery in this environment.
  it("retries a failed send up to 3 times before giving up on the first message", async () => {
    const support = new ChatTurnSupport(logger());
    const first = vi.fn(() => Promise.reject(new Error("network blip")));

    await expect(support.deliverChatResponse({
      sender: { first, rest: vi.fn() },
      text: "Hello.",
      sources: [],
      images: [],
      emptyFallbackContent: "I ran out of words.",
      maxImageAggregateBytes: 10 * oneMiB,
    })).rejects.toThrow("network blip");
    expect(first).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("stops after a later chunk fails 3 times, posts a partial-delivery notice, and does not throw", async () => {
    const support = new ChatTurnSupport(logger());
    const first = vi.fn((_payload: ChatDeliveryPayload) => Promise.resolve(fakeMessage("1")));
    let restCallCount = 0;
    const rest = vi.fn((_payload: ChatDeliveryPayload) => {
      restCallCount += 1;
      // The failing chunk's first 3 calls (its retry attempts) reject; the
      // partial-delivery notice sent afterward succeeds.
      if (restCallCount <= 3) return Promise.reject(new Error("discord 500"));
      return Promise.resolve(fakeMessage(`ok-${restCallCount}`));
    });
    const text = "word ".repeat(900).trim(); // multiple chunks

    const result = await support.deliverChatResponse({
      sender: { first, rest },
      text,
      sources: [],
      images: [],
      emptyFallbackContent: "I ran out of words.",
      maxImageAggregateBytes: 10 * oneMiB,
    });

    expect(result.deliveredText).toBe(text);
    // 3 failed retries for the failing chunk, plus 1 successful notice send.
    expect(rest).toHaveBeenCalledTimes(4);
    expect(rest.mock.calls.at(-1)?.[0]?.content).toContain("couldn't be delivered");
  }, 10_000);
});
