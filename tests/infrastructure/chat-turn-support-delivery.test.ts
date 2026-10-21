import { Collection, type Message } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";

import { ChatTurnSupport, type ChatDeliveryPayload } from "../../src/infrastructure/discord/behaviors/chat-turn-support.js";
import type { GeneratedChatImage } from "../../src/application/chat/chat-provider.js";
import { captureIncompleteTurnProvenance } from "../../src/application/chat/context-provenance.js";
import { hashContent } from "../../src/application/assets/content-hash.js";
import { decisionRequest } from "../helpers/conversation-decision-fixtures.js";
import type { MessageOriginRecord } from "../../src/application/chat/message-origin-store.js";
import { GuardedConversationContext, guardedAssetsHash } from "../../src/application/chat/guarded-conversation-context.js";
import { guardedFixture } from "../helpers/guarded-context-fixture.js";

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
  it("binds a confirmed bot image's attachment identity into its output origin", async () => {
    const fixture = guardedFixture();
    const lease = await GuardedConversationContext.open(fixture.port, { count: 40, budget: 12000, burstIds: [] });
    const recorded: MessageOriginRecord[] = [];
    const support = new ChatTurnSupport(logger(), null, { record: (record): Promise<void> => { recorded.push(record); return Promise.resolve(); }, find: (): Promise<null> => Promise.resolve(null) });
    const sent = { id: "sent", content: "a picture", attachments: new Collection([["output-image", { id: "output-image", size: 10, contentType: "image/png" }]]) } as unknown as Message;
    await support.deliverChatResponse({ sender: { first: () => Promise.resolve(sent), rest: vi.fn() }, text: "a picture", sources: [], images: [image(10)],
      emptyFallbackContent: "empty", maxImageAggregateBytes: oneMiB, contextLease: lease,
      sourceMessage: { id: "current", guildId: "guild", channelId: "channel", author: { bot: false } } as Message });
    expect(recorded[0]?.contextProvenance?.outputAssetsHash).toBe(guardedAssetsHash([{ id: "output-image", size: 10, contentType: "image/png" }]));
    expect(recorded[0]?.contextProvenance?.coverage).toBe("complete");
  });

  it("reuses one enforced nonce after an accepted send loses its response", async () => {
    const support = new ChatTurnSupport(logger()); const visible = new Map<string, Message>();
    let attempts = 0;
    const first = vi.fn((payload: ChatDeliveryPayload): Promise<Message> => {
      expect(payload.enforceNonce).toBe(true); expect(payload.nonce).toMatch(/^[a-f0-9]{24}$/u);
      const existing = visible.get(payload.nonce); if (existing) return Promise.resolve(existing);
      const sent = { id: `sent-${visible.size}`, content: payload.content } as Message; visible.set(payload.nonce, sent);
      if (attempts++ === 0) return Promise.reject(Object.assign(new Error("lost response"), { code: "ECONNRESET" }));
      return Promise.resolve(sent);
    });
    const recordDelivery = vi.fn();
    const params = { sender: { first, rest: vi.fn() }, text: "Hello", sources: [], images: [], emptyFallbackContent: "empty", maxImageAggregateBytes: oneMiB, recordDelivery };
    await support.deliverChatResponse(params);
    expect(first).toHaveBeenCalledTimes(2); expect(visible.size).toBe(1); expect(recordDelivery).toHaveBeenCalledOnce();
    expect(first.mock.calls[0]![0].nonce).toBe(first.mock.calls[1]![0].nonce);
    await support.deliverChatResponse(params);
    expect(visible.size).toBe(2); // A new logical reply gets a new nonce.
  });

  it.each([400, 401, 403, 404, 429])("does not retry HTTP %s or send an extra notice after a partial reply", async (status) => {
    const support = new ChatTurnSupport(logger());
    const first = vi.fn((payload: ChatDeliveryPayload) => Promise.resolve({ id: "sent", content: payload.content } as Message));
    const rest = vi.fn(() => Promise.reject(Object.assign(new Error("SECRET_DISCORD_ERROR"), { status })));
    const text = "word ".repeat(900);
    const result = await support.deliverChatResponse({ sender: { first, rest }, text, sources: [], images: [], emptyFallbackContent: "empty", maxImageAggregateBytes: oneMiB });
    expect(rest).toHaveBeenCalledOnce(); expect(result.deliveredText).toBe(first.mock.calls[0]![0].content);
    expect(result.deliveredText.length).toBeLessThan(text.length);
  });

  it("does not retry REST rate-limit rejections without an HTTP status", async () => {
    const support = new ChatTurnSupport(logger());
    const first = vi.fn(() => Promise.reject(Object.assign(new Error("rate limited"), { retryAfter: 30000 })));
    await expect(support.deliverChatResponse({ sender: { first, rest: vi.fn() }, text: "Hello", sources: [], images: [], emptyFallbackContent: "empty", maxImageAggregateBytes: oneMiB })).rejects.toThrow("rate limited");
    expect(first).toHaveBeenCalledOnce();
  });

  it("never repeats acknowledged sends because delivery bookkeeping failed", async () => {
    const { logger: log, records } = captureDiagnosticLogger();
    const record = vi.fn((): Promise<void> => { throw new Error("SECRET_ORIGIN_FAILURE"); });
    const support = new ChatTurnSupport(log, null, { record, find: (): Promise<null> => Promise.resolve(null) });
    const first = vi.fn((payload: ChatDeliveryPayload) => Promise.resolve({ id: "sent", content: payload.content } as Message));
    const recordDelivery = vi.fn(() => { throw new Error("SECRET_PROOF_FAILURE"); });
    const result = await support.deliverChatResponse({ sender: { first, rest: vi.fn() }, text: "Hello", sources: [], images: [], emptyFallbackContent: "empty", maxImageAggregateBytes: oneMiB,
      sourceMessage: { id: "source", guildId: "guild", channelId: "channel", author: { bot: false } } as Message, recordDelivery });
    expect(result.deliveredText).toBe("Hello"); expect(first).toHaveBeenCalledOnce(); expect(recordDelivery).toHaveBeenCalledOnce(); expect(record).toHaveBeenCalledOnce();
    expect(records.filter((entry) => entry.event === "chat.delivery.bookkeeping_failed").map((entry) => entry.stage)).toEqual(["proof", "origin"]);
    expect(JSON.stringify(records)).not.toContain("SECRET");
  });

  it("uses independent nonces for every part of a multi-part reply", async () => {
    const support = new ChatTurnSupport(logger()); const nonces: string[] = [];
    const send = (payload: ChatDeliveryPayload): Promise<Message> => { nonces.push(payload.nonce); return Promise.resolve({ id: payload.nonce, content: payload.content } as Message); };
    await support.deliverChatResponse({ sender: { first: send, rest: send }, text: "word ".repeat(900), sources: [], images: [], emptyFallbackContent: "empty", maxImageAggregateBytes: oneMiB });
    expect(nonces.length).toBeGreaterThan(1); expect(new Set(nonces).size).toBe(nonces.length);
  });

  it("revalidates every guarded part and returns only text actually sent after revocation", async () => {
    const fixture = guardedFixture();
    const lease = await GuardedConversationContext.open(fixture.port, { count: 40, budget: 12000, burstIds: [] });
    const support = new ChatTurnSupport(logger()); const text = "word ".repeat(900);
    let confirmed = "";
    const first = vi.fn((payload: ChatDeliveryPayload) => {
      confirmed = payload.content; fixture.denied.add("current");
      return Promise.resolve({ id: "first", content: confirmed } as Message);
    });
    const rest = vi.fn(() => Promise.resolve(fakeMessage("never")));
    const result = await support.deliverChatResponse({ sender: { first, rest }, text, sources: [], images: [],
      emptyFallbackContent: "empty", maxImageAggregateBytes: oneMiB, contextLease: lease });
    expect(first).toHaveBeenCalledOnce(); expect(rest).not.toHaveBeenCalled();
    expect(result.deliveredText).toBe(confirmed); expect(result.deliveredText.length).toBeLessThan(text.length);
  });
  it("binds dependencies separately to each confirmed delivery part", async () => {
    const recorded: MessageOriginRecord[] = [];
    const support = new ChatTurnSupport(logger(), null, { record: (record): Promise<void> => { recorded.push(record); return Promise.resolve(); }, find: (): Promise<null> => Promise.resolve(null) });
    const text = "word ".repeat(500);
    const proof = captureIncompleteTurnProvenance(decisionRequest(), text)!;
    const contents: string[] = [];
    const send = (payload: ChatDeliveryPayload): Promise<Message> => {
      contents.push(payload.content); return Promise.resolve({ id: `part-${contents.length}`, content: payload.content } as Message);
    };
    await support.deliverChatResponse({ sender: { first: send, rest: send }, text, sources: [], images: [], emptyFallbackContent: "empty",
      sourceMessage: { id: "trigger", guildId: "guild", channelId: "channel", author: { bot: false } } as Message,
      contextProvenance: proof, maxImageAggregateBytes: oneMiB });
    expect(recorded.length).toBeGreaterThan(1);
    expect(recorded.map((record) => record.contextProvenance?.outputHash)).toEqual(contents.map(hashContent));
    expect(recorded.every((record) => record.contextProvenance?.coverage === "partial")).toBe(true);
  });
  it("falls back to safe Discord chunks when character-shaped paragraphs exceed the message limit", async () => {
    const support = new ChatTurnSupport(logger()); const payloads: ChatDeliveryPayload[] = [];
    const send = (payload: ChatDeliveryPayload): Promise<Message> => { payloads.push(payload); return Promise.resolve(fakeMessage(String(payloads.length))); };
    const paragraphs = ["word ".repeat(500).trim(), "another paragraph"];
    await support.deliverChatResponse({ sender: { first: send, rest: send }, text: paragraphs.join("\n\n"), characterMessages: paragraphs,
      sources: [], images: [], emptyFallbackContent: "empty", maxImageAggregateBytes: 10 * oneMiB });
    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads.every((payload) => payload.content.length <= 2000)).toBe(true);
    expect(payloads.map((payload) => payload.content).join(" ")).toContain("another paragraph");
  });
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

    expect(first).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: "Hello there.", files: [] }));
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

    expect(first).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: "I ran out of words.", files: [] }));
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
  // (1.5 seconds total), and faking it introduced a flaky
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
    const capture = captureDiagnosticLogger();
    const support = new ChatTurnSupport(capture.logger);
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

    expect(capture.records.filter((record) => record.event === "chat.delivery.completed")).toEqual([
      expect.objectContaining({ status: "partial", deliveredParts: 1 }),
    ]);

    expect(result.deliveredText).toBe(first.mock.calls[0]![0].content);
    // 3 failed retries for the failing chunk, plus 1 successful notice send.
    expect(rest).toHaveBeenCalledTimes(4);
    expect(rest.mock.calls.at(-1)?.[0]?.content).toContain("Only part");
  }, 10_000);
});
