import { describe, expect, it, vi } from "vitest";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { decodeSimpleDecision, personaDigest, personaDigestChars, selectSimpleRoute, SimpleParticipationService, simplePrompt, type SimpleDecisionInput, type SimpleRoute } from "../../src/application/chat/simple-decision.js";
import type { ChannelHistoryMessage, StructuredCharacterProvider } from "../../src/application/chat/chat-provider.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import { buildEmojiChoices, serverEmojiCap, unicodeEmojiChoices } from "../../src/application/chat/simple-emoji.js";

const all = ["reply", "react", "ignore"] as const;
const event = (messageId: string, timestampMs: number, authorId: string, content: string): ChannelHistoryMessage => guardedEvent(messageId, timestampMs, content, authorId);

async function input(overrides: Partial<SimpleDecisionInput> = {}): Promise<SimpleDecisionInput> {
  const current = event("current", 4000, "alice", "<b>can you help</b>");
  const source = guardedFixture(current, { guildId: "guild", channelId: "channel" });
  const sourceContext = await GuardedConversationContext.open(source.port, { count: 0, budget: 0, burstIds: [] });
  return { sourceContext, personality: "A friendly cat\nsecond line", botId: "bot", botName: "Bot", events: [event("earlier", 1000, "bob", "hi all")], current,
    kind: "joining", basis: null, actions: { reply: true, react: true }, emoji: unicodeEmojiChoices, thoughts: false, held: null, ...overrides };
}
const route = (provider: StructuredCharacterProvider, source: SimpleRoute["source"] = "reply", reasoningEffort: SimpleRoute["reasoningEffort"] = "low"): SimpleRoute =>
  ({ provider, source, endpoint: source === "native" ? "decisions" : "reply-provider", model: "m", reasoningEffort });
const native = (values: Record<string, unknown>, confidence: Record<string, unknown> = { action: 0.9 }): unknown => ({ values, confidence });

describe("simple decision decoding", () => {
  it("accepts a valid LLM action and reads the emoji only for react", () => {
    expect(decodeSimpleDecision({ action: "reply", emoji: "👍" }, false, all)).toEqual({ action: "reply", emoji: null, reactionSelectionFailed: false, score: null });
    expect(decodeSimpleDecision({ action: "react", emoji: "😂" }, false, all)).toMatchObject({ action: "react", emoji: "😂", reactionSelectionFailed: false });
    expect(decodeSimpleDecision({ action: "ignore", emoji: "none" }, false, all)).toMatchObject({ action: "ignore", emoji: null });
  });
  it("never lets a bad emoji void reply or ignore, but fails a react", () => {
    for (const emoji of [undefined, "none", "🦄", 7, null]) {
      expect(decodeSimpleDecision({ action: "reply", emoji }, false, all)).toMatchObject({ action: "reply", reactionSelectionFailed: false });
      expect(decodeSimpleDecision({ action: "ignore", emoji }, false, all)).toMatchObject({ action: "ignore" });
      expect(decodeSimpleDecision({ action: "react", emoji }, false, all)).toMatchObject({ action: "react", emoji: null, reactionSelectionFailed: true });
    }
  });
  it("rejects an invalid, unavailable or malformed action as a failure", () => {
    expect(decodeSimpleDecision({ action: "shout", emoji: "none" }, false, all)).toBeNull();
    expect(decodeSimpleDecision({ action: "react", emoji: "👍" }, false, ["reply", "ignore"])).toBeNull();
    expect(decodeSimpleDecision({ action: "reply", extra: true }, false, all)).toBeNull();
    expect(decodeSimpleDecision("reply", false, all)).toBeNull();
  });
  it("reads native action probability and tolerates an absent emoji answer", () => {
    expect(decodeSimpleDecision(native({ action: "reply" }, { action: 0.81 }), true, all)).toEqual({ action: "reply", emoji: null, reactionSelectionFailed: false, score: 0.81 });
    expect(decodeSimpleDecision(native({ action: "react", emoji: "❤️" }, { action: 0.7, emoji: 0.6 }), true, all)).toMatchObject({ emoji: "❤️", score: 0.7 });
    expect(decodeSimpleDecision(native({ action: "react" }, { action: 0.7 }), true, all)).toMatchObject({ reactionSelectionFailed: true });
    expect(decodeSimpleDecision(native({ action: "reply" }, {}), true, all)).toBeNull();
    expect(decodeSimpleDecision(native({ action: "reply" }, { action: 2 }), true, all)).toBeNull();
  });
});

describe("simple decision prompt", () => {
  it("carries the bounded package and nothing from memories, lore or modules", async () => {
    const prompt = simplePrompt(await input({ actions: { reply: true, react: false } }), "decision");
    expect(prompt).toContain("A friendly cat second line"); expect(prompt).toContain('"shareOfRecentMessagesPercent":0');
    expect(prompt).toContain("chance to join in"); expect(prompt).toContain('"availableActions":["reply","ignore"]');
    expect(prompt).toContain("\\u003cb>can you help"); expect(prompt).not.toContain("<b>");
    expect(prompt).not.toMatch(/memor|lore|drift|alias|character:/iu);
  });
  it("names the follow-up basis and a still-authorized held thought", async () => {
    const base = await input({ kind: "followup", basis: "open_exchange", held: { sourceMessageId: "earlier", stance: "agree", length: "one_line" } });
    const prompt = simplePrompt(base, "decision");
    expect(prompt).toContain("follow-up"); expect(prompt).toContain("might also have turned to something else");
    expect(prompt).toContain("held back from replying to m1"); expect(prompt).toContain("one-line agree reply");
    expect(simplePrompt({ ...base, held: { sourceMessageId: "gone", stance: "agree", length: "short" } }, "decision")).not.toContain("held back");
  });
});

describe("persona digest", () => {
  it("collapses whitespace, drops heading marks and caps the length", () => {
    expect(personaDigest("# Mochi\n\nA  calm cat.")).toBe("Mochi A calm cat.");
    const long = personaDigest("word ".repeat(400));
    expect(long.length).toBe(personaDigestChars); expect(long.endsWith("…")).toBe(true);
  });
  it("reports how much of the recent conversation the bot wrote", async () => {
    const base = await input({ events: [event("a", 1000, "bot", "hi"), event("b", 2000, "bob", "yo"), event("c", 3000, "bob", "ok"), event("d", 3500, "bob", "sure")] });
    expect(simplePrompt(base, "decision")).toContain('"shareOfRecentMessagesPercent":25');
  });
});

describe("simple participation service", () => {
  it("makes one request with the decision reasoning effort and no thought request by default", async () => {
    const generate = vi.fn(() => Promise.resolve({ action: "reply", emoji: "none" }));
    const outcome = await new SimpleParticipationService(route({ generateCharacterData: generate })).decide(await input());
    expect(outcome).toMatchObject({ status: "valid", action: "reply", scoreKind: "unavailable", thought: null, route: { source: "reply", reasoningEffort: "low" } });
    expect(generate).toHaveBeenCalledOnce();
    expect((generate.mock.calls as unknown[][])[0]![2]).toMatchObject({ reasoningEffort: "low", maxAttempts: 1 });
  });
  it("asks the thought question concurrently, only when reply is available, and a thought failure never changes the decision", async () => {
    const generate = vi.fn((prompt: string) => prompt.includes("Imagine the bot replies") ? Promise.reject(new Error("boom")) : Promise.resolve({ action: "ignore", emoji: "none" }));
    const service = new SimpleParticipationService(route({ generateCharacterData: generate }));
    const failed = await service.decide(await input({ thoughts: true }));
    expect(generate).toHaveBeenCalledTimes(2);
    expect(failed).toMatchObject({ status: "valid", action: "ignore", thought: { status: "failed", stance: null } });
    generate.mockClear();
    await service.decide(await input({ thoughts: true, actions: { reply: false, react: true } }));
    expect(generate).toHaveBeenCalledOnce();
  });
  it("decodes a valid thought and defaults a bad length", async () => {
    const generate = vi.fn((prompt: string) => Promise.resolve(prompt.includes("Imagine the bot replies") ? { stance: "joke", length: "huge" } : { action: "reply", emoji: "none" }));
    const outcome = await new SimpleParticipationService(route({ generateCharacterData: generate })).decide(await input({ thoughts: true }));
    expect(outcome.thought).toMatchObject({ status: "valid", stance: "joke", length: "short", want: null });
    const failed = await new SimpleParticipationService(route({ generateCharacterData: () => Promise.resolve({ stance: "rant", length: "short" }) })).decide(await input({ thoughts: true }));
    expect(failed.thought).toMatchObject({ status: "failed", failure: "invalid_output" });
  });
  it("records a transport failure or an invalid action as a failure, never as a model ignore", async () => {
    const failing = await new SimpleParticipationService(route({ generateCharacterData: () => Promise.reject(Object.assign(new Error("slow"), { name: "TimeoutError" })) })).decide(await input());
    expect(failing).toMatchObject({ status: "failed", action: null, failure: "timeout" });
    const invalid = await new SimpleParticipationService(route({ generateCharacterData: () => Promise.resolve({ action: "shout", emoji: "none" }) })).decide(await input());
    expect(invalid).toMatchObject({ status: "failed", action: null, failure: "invalid_output" });
    expect(await new SimpleParticipationService(null).decide(await input())).toMatchObject({ status: "unavailable", action: null });
  });
  it("propagates a revoked lease instead of treating it as a failure", async () => {
    const generate = vi.fn(() => Promise.reject(new SocialOutputSuppressed()));
    await expect(new SimpleParticipationService(route({ generateCharacterData: generate })).decide(await input())).rejects.toBeInstanceOf(SocialOutputSuppressed);
  });
  it("uses the native action probability and a native schema without an emoji question when react is unavailable", async () => {
    const generate = vi.fn(() => Promise.resolve(native({ action: "reply" }, { action: 0.77 })));
    const outcome = await new SimpleParticipationService(route({ generateCharacterData: generate }, "native", null)).decide(await input({ actions: { reply: true, react: false } }));
    expect(outcome).toMatchObject({ status: "valid", action: "reply", score: 0.77, scoreKind: "native_probability" });
    const schema = (generate.mock.calls as unknown as [string, { properties: Record<string, { enum?: string[] }> }][])[0]![1];
    expect(schema).toMatchObject({ "x-native-simple": true }); expect(Object.keys(schema.properties)).toEqual(["action"]);
    expect(schema.properties.action!.enum).toEqual(["reply", "ignore"]);
  });
});

describe("simple route selection", () => {
  const provider = (): StructuredCharacterProvider => ({ generateCharacterData: () => Promise.resolve({}) });
  const details = { decisionModel: "d", replyModel: "r", dedicatedEffort: "minimal" as const, replyEffort: "low" as const };
  it("prefers native, then a dedicated model, then the reply model, and never the utility model", () => {
    expect(selectSimpleRoute({ native: provider(), dedicated: provider(), reply: provider() }, details)).toMatchObject({ source: "native", endpoint: "decisions", reasoningEffort: null });
    expect(selectSimpleRoute({ native: null, dedicated: provider(), reply: provider() }, details)).toMatchObject({ source: "dedicated", model: "d", reasoningEffort: "minimal" });
    expect(selectSimpleRoute({ native: null, dedicated: null, reply: provider() }, details)).toMatchObject({ source: "reply", model: "r", reasoningEffort: "low" });
    expect(selectSimpleRoute({ native: null, dedicated: null, reply: null }, details)).toBeNull();
  });
});

describe("join confirmation", () => {
  it("asks a strict yes/no question on the same route and reads only a clear answer", async () => {
    const seen: string[] = [];
    const ask = (answer: unknown): SimpleParticipationService => new SimpleParticipationService(route({ generateCharacterData: vi.fn((prompt: string) => { seen.push(prompt); return Promise.resolve(answer); }) }));
    expect(await ask({ confirm: "yes" }).confirmJoin(await input(), "reply")).toMatchObject({ confirmed: true });
    expect(await ask({ confirm: "no" }).confirmJoin(await input(), "react")).toMatchObject({ confirmed: false });
    expect(await ask({ confirm: "maybe" }).confirmJoin(await input(), "reply")).toMatchObject({ confirmed: null, failure: "invalid_output" });
    expect(await ask({ confirm: "yes", extra: 1 }).confirmJoin(await input(), "reply")).toMatchObject({ confirmed: null });
    expect(seen[0]).toContain("so be strict"); expect(seen[1]).toContain("add an emoji reaction");
    expect(seen[0]).not.toContain("<b>");
  });
  it("reads the native answer and treats a provider failure as no confirmation", async () => {
    const nativeAsk = new SimpleParticipationService(route({ generateCharacterData: vi.fn(() => Promise.resolve(native({ confirm: "yes" }, { confirm: 0.8 }))) }, "native", null));
    expect(await nativeAsk.confirmJoin(await input(), "reply")).toMatchObject({ confirmed: true });
    const failing = new SimpleParticipationService(route({ generateCharacterData: vi.fn(() => Promise.reject(new Error("down"))) }));
    expect(await failing.confirmJoin(await input(), "reply")).toMatchObject({ confirmed: null });
    expect(await new SimpleParticipationService(null).confirmJoin(await input(), "reply")).toMatchObject({ confirmed: null, failure: "unavailable" });
  });
});

describe("emoji choices", () => {
  const server = Array.from({ length: 60 }, (_, index) => ({ id: String(1000 + index), name: `emoji_${index}`, animated: index % 2 === 0 }));
  it("adds a capped random sample of server emoji to the Unicode set, by name and never by ID", () => {
    const choices = buildEmojiChoices(server, "message-1");
    expect(choices.filter((choice) => choice.kind === "unicode")).toHaveLength(unicodeEmojiChoices.length);
    expect(choices.filter((choice) => choice.kind === "custom")).toHaveLength(serverEmojiCap);
    expect(choices.every((choice) => choice.kind === "unicode" || choice.token === `:${choice.name}:`)).toBe(true);
    expect(choices.map((choice) => choice.token).join()).not.toMatch(/d{4}/u);
    expect(new Set(choices.map((choice) => choice.token)).size).toBe(choices.length);
  });
  it("draws a new sample for each decision but keeps one decision stable", () => {
    const tokens = (seed: string): string => buildEmojiChoices(server, seed).map((choice) => choice.token).join();
    expect(tokens("message-1")).toBe(tokens("message-1"));
    expect(new Set(["a", "b", "c", "d", "e"].map(tokens)).size).toBeGreaterThan(1);
  });
  it("skips duplicate or unusable names and handles a server with few or no custom emoji", () => {
    const odd = [{ id: "1", name: "ok", animated: false }, { id: "2", name: "ok", animated: false }, { id: "3", name: "bad name", animated: false }, { id: "4", name: "a", animated: false }];
    expect(buildEmojiChoices(odd, "x").filter((choice) => choice.kind === "custom")).toHaveLength(1);
    expect(buildEmojiChoices([], "x")).toEqual(unicodeEmojiChoices);
  });
  it("offers the sample in the schema and prompt and accepts only an offered name", async () => {
    const choices = buildEmojiChoices(server, "message-1"); const custom = choices.find((choice) => choice.kind === "custom")!;
    const calls: { prompt: string; schema: Record<string, unknown> }[] = [];
    const provider: StructuredCharacterProvider = { generateCharacterData: vi.fn((prompt: string, schema: Record<string, unknown>) => { calls.push({ prompt, schema }); return Promise.resolve({ action: "react", emoji: custom.token }); }) };
    const outcome = await new SimpleParticipationService(route(provider)).decide(await input({ emoji: choices }));
    expect(outcome).toMatchObject({ status: "valid", action: "react", emoji: custom.token, reactionSelectionFailed: false });
    expect(outcome.emojiChoice).toEqual(custom);
    const properties = calls[0]!.schema.properties as { emoji: { enum: string[] } };
    expect(properties.emoji.enum).toEqual([...choices.map((choice) => choice.token), "none"]);
    expect(calls[0]!.prompt).toContain(custom.token); expect(calls[0]!.prompt).not.toContain(custom.kind === "custom" ? custom.id : "");
    expect(decodeSimpleDecision({ action: "react", emoji: ":not_offered:" }, false, all, choices.map((choice) => choice.token))).toMatchObject({ emoji: null, reactionSelectionFailed: true });
  });
});
