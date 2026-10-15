import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CharacterDecisionService, allowsOptionalParticipation, contributionLabels, exchangeBranch, localAddressing, type CharacterDecision } from "../../src/application/chat/character-decision.js";
import { replayParticipation } from "../../src/application/chat/participation-evaluation.js";
import { ChatScheduler, balancedChatLimits } from "../../src/application/chat/chat-scheduler.js";
import { contributionPolicy, defaultParticipation, passiveChannelAllowed, resolveParticipation } from "../../src/application/chat/participation-policy.js";
import { guildConfigurationFileSchema } from "../../src/config/guild-configuration-schema.js";
import { applyGuildConfigurationUpdate } from "../../src/config/guild-configuration-document.js";
import { freshDocument, freshProfile } from "../helpers/settings-fixtures.js";
import type { ChannelHistoryMessage } from "../../src/application/chat/chat-provider.js";
import { ConversationEpisodes } from "../../src/application/chat/conversation-episodes.js";
import { addressesBotName } from "../../src/domain/chat/name-mention.js";

const candidate = { text: "Here is one specific tradeoff", adds: "A new tradeoff", label: "specific-opinion" as const, sourceMessageId: "current", recipientId: "alice", motivation: 0.9 };
const decision: CharacterDecision = { addressing: "continuing", motivation: 0.9, confidence: 0.9, recipientConfidence: 0.9, targetConfidence: 0.9, recipientEvidence: ["current"], target: "current", boundary: "earlier", opening: "clear", contribution: candidate, thoughts: [], reaction: null };
function event(messageId: string, timestampMs: number, authorId = "alice", extra: Partial<ChannelHistoryMessage> = {}): ChannelHistoryMessage {
  return { messageId, timestampMs, authorId, authorDisplayName: authorId, content: "A specific question", imageCount: 0, ...extra };
}
const original = event("initial", 1000);
const bot = event("reply", 8000, "bot", { replyToMessageId: "initial", replyToAuthorId: "alice" });
const current = event("current", 60000);
const input = { personality: "test", events: [original, bot], burst: [current], botId: "bot", fixedTarget: null, gapMs: 600_000, speakingShare: 0, thoughts: false };

describe("participation safety and replay", () => {
  it("matches the synthetic recipient/contribution replay and retains welcome contributions", async () => {
    const fixture: unknown = JSON.parse(readFileSync(new URL("../fixtures/participation-replay.json", import.meta.url), "utf8"));
    const outputs = await replayParticipation(fixture);
    expect(outputs.filter((row) => !row.correct)).toEqual([]);
    expect(outputs.some((row) => row.name === "welcome spontaneous group joke" && row.proposed)).toBe(true);
    expect(outputs.some((row) => row.baseline && !row.proposed)).toBe(true);
  });
  it.each(contributionLabels.slice(5))("never admits rejected label %s at any score", (label) => {
    for (const score of [0, 0.5, 0.75, 0.99, 1]) for (const trigger of ["continuation", "spontaneous"] as const)
      expect(allowsOptionalParticipation(trigger, "continuing", { ...decision, motivation: 1, contribution: { ...candidate, label, motivation: score } }, false, { spontaneousThreshold: 0, continuationThreshold: 0 })).toBe(false);
  });
  it("has monotone configurable thresholds with no hidden spontaneous cutoff", () => {
    const recorded = { ...decision, addressing: "others" as const, contribution: { ...candidate, motivation: 0.6 } };
    expect(allowsOptionalParticipation("spontaneous", "others", recorded, false, { spontaneousThreshold: 0.6, continuationThreshold: 0.5 })).toBe(true);
    const values = [0, 0.5, 0.6, 0.7, 1].map((threshold) => allowsOptionalParticipation("spontaneous", "others", recorded, false, { spontaneousThreshold: threshold, continuationThreshold: 0.5 }));
    expect(values).toEqual([true, true, true, false, false]);
  });
  it("distinguishes unavailable and failed providers and uses the utility fallback", async () => {
    expect(await new CharacterDecisionService(null).evaluate(input)).toEqual({ status: "unavailable", decision: null });
    const failed = { generateCharacterData: vi.fn(() => Promise.reject(new Error("offline"))) };
    expect(await new CharacterDecisionService(failed).evaluate(input)).toEqual({ status: "failed", decision: null });
    const fallback = { generateCharacterData: vi.fn(() => Promise.resolve(decision)) };
    expect((await new CharacterDecisionService(failed, fallback).evaluate(input)).status).toBe("valid");
    expect(fallback.generateCharacterData).toHaveBeenCalledOnce();
  });
  it("rejects invented/future evidence, wrong recipients and answered targets", async () => {
    for (const invalid of [{ ...decision, recipientEvidence: ["future"] }, { ...decision, target: "invented" }, { ...decision, contribution: { ...candidate, recipientId: "bob" } }, { ...decision, target: "initial", contribution: { ...candidate, sourceMessageId: "initial" } }]) {
      const provider = { generateCharacterData: (): Promise<unknown> => Promise.resolve(invalid) };
      expect((await new CharacterDecisionService(provider).evaluate({ ...input, events: [...input.events, event("future", 999999)] })).status).toBe("failed");
    }
  });
  it("renews a window once per new human message and retains a stable implicit branch", () => {
    const extra = { ...bot, messageId: "extra", timestampMs: 120000 };
    expect(localAddressing([original, bot, extra], event("late", 140000), "bot", true)).toBe("others");
    const second = event("second", 60000);
    const secondBot = event("second-reply", 65000, "bot", { replyToMessageId: "second", replyToAuthorId: "alice" });
    const third = event("third", 170000);
    expect(localAddressing([original, bot, second, secondBot], third, "bot", true)).toBe("continuing");
    expect(exchangeBranch([original, bot, second, secondBot], third, "bot")).toBe("initial");
    const bystander = event("bystander", 2000, "bob");
    const unsolicited = event("extra-to-bob", 120000, "bot", { replyToMessageId: "bystander", replyToAuthorId: "bob" });
    expect(localAddressing([original, bystander, bot, unsolicited], event("bob-now", 140000, "bob"), "bot", true)).toBe("others");
  });
  it("supports six human-engaged follow-ups without resetting the branch on every turn", () => {
    const history = [original, bot];
    for (let index = 1; index <= 6; index++) {
      const human = event(`human-${index}`, 8000 + index * 30000);
      expect(localAddressing(history, human, "bot", true)).toBe("continuing");
      expect(exchangeBranch(history, human, "bot")).toBe("initial");
      history.push(human, event(`bot-${index}`, human.timestampMs + 1000, "bot", { replyToMessageId: human.messageId, replyToAuthorId: human.authorId }));
    }
  });
  it("recognizes only addressed bot names and eligible unambiguous aliases", () => {
    expect(addressesBotName("Bob is pretty funny", "Bob")).toBe(false);
    expect(addressesBotName("Bob, did you see it?", "Bob")).toBe(true);
    expect(addressesBotName("阿明你怎麼看？", "阿明")).toBe(true);
    const alias = [{ alias: "Ace", subjectIds: ["bob"] }];
    expect(localAddressing([original, bot], { ...current, content: "Ace, what do you think?" }, "bot", true, 120000, alias)).toBe("others");
    expect(localAddressing([original, bot], { ...current, content: "Ace, what do you think?" }, "bot", true, 120000, [{ alias: "Ace", subjectIds: ["bob", "carol"] }])).toBe("unclear");
  });
  it("migrates the restrictive legacy threshold once, with explicit new values taking precedence", () => {
    const document = freshDocument(); delete document.chat.participation.spontaneousThreshold;
    document.character.enabled = true; document.character.modules.thoughts.enabled = true; document.character.modules.thoughts.shadow = false; document.character.modules.thoughts.threshold = 0.95;
    const migrated = guildConfigurationFileSchema.parse(document);
    expect(migrated.chat.participation.spontaneousThreshold).toBe(0.95);
    const changed = applyGuildConfigurationUpdate(migrated, { character: { modules: { thoughts: { threshold: 0.1 } } } });
    expect(changed.chat.participation.spontaneousThreshold).toBe(0.95);
    expect(contributionPolicy({ ...defaultParticipation, spontaneousThreshold: 0.4 }, document.character.modules.thoughts).spontaneousThreshold).toBe(0.4);
  });
  it("does not restore deleted or edited sources from persisted context, including their reply branches", () => {
    const episodes = new ConversationEpisodes(); episodes.observe("g:c", original, 60000); episodes.observe("g:c", bot, 60000);
    episodes.excludeInteraction("g:c", original.messageId);
    const version = episodes.version("g:c");
    episodes.observe("g:c", original, 60000); episodes.observe("g:c", bot, 60000);
    expect(episodes.windowSnapshot("g:c", 15, 60000)).toEqual([]);
    expect(episodes.version("g:c")).toBe(version);
  });
  it("preserves the former shadow-thought pause once without adding a runtime thought gate", () => {
    const document = freshDocument(); delete document.chat.participation.spontaneousThreshold;
    document.features.channelHistory = true; document.character.enabled = true;
    document.character.modules.thoughts.enabled = true; document.character.modules.addressing.enabled = true;
    document.chat.participation.continuationEnabled = true; document.chat.participation.spontaneousEnabled = true;
    document.chat.participation.spontaneousChannelIds = ["500000000000000001"];
    const migrated = guildConfigurationFileSchema.parse(document);
    expect(migrated.chat.participation.channelOverrides["500000000000000001"]?.spontaneousEnabled).toBe(false);
    const optedIn = applyGuildConfigurationUpdate(migrated, { chatParticipation: { channelOverrides: { "500000000000000001": { spontaneousEnabled: true } } } });
    expect(optedIn.chat.participation.channelOverrides["500000000000000001"]?.spontaneousEnabled).toBe(true);
  });
  it("keeps passive empty scope closed and does not inherit parent channels into threads", () => {
    const profile = freshProfile(); profile.channels.chatbot = new Set(["parent"]);
    expect(passiveChannelAllowed(profile, "parent")).toBe(true);
    expect(passiveChannelAllowed(profile, "thread")).toBe(false);
    profile.chat.participation = { ...defaultParticipation, observationChannelIds: [] };
    expect(passiveChannelAllowed(profile, "parent")).toBe(false);
    profile.chat.participation = { ...defaultParticipation, observationChannelIds: ["thread"] };
    expect(passiveChannelAllowed(profile, "thread")).toBe(true);
  });
  it("quiet activity constrains optional continuation as well as spontaneous output", () => {
    const quiet = resolveParticipation({ ...defaultParticipation, activity: "quiet" }, "c").limits;
    const balanced = resolveParticipation(defaultParticipation, "c").limits;
    expect(quiet.continuationIntervalMs).toBeGreaterThan(balanced.continuationIntervalMs!);
    expect(quiet.continuationPerExchange).toBeLessThan(balanced.continuationPerExchange!);
    expect(quiet.textPerWindow).toBeLessThan(balanced.textPerWindow);
  });
  it("enforces reservations, channel intervals and aggregate quotas across branches; only delivery consumes them", () => {
    let now = 1000; const scheduler = new ChatScheduler(() => now);
    const limits = { ...balancedChatLimits, continuation: true, continuationIntervalMs: 15000, continuationPerExchange: 5, continuationPerWindow: 2, exchangeId: "a" };
    const first = scheduler.reserveOutput("g:c", "text", limits, true)!;
    expect(scheduler.reserveOutput("g:c", "text", { ...limits, exchangeId: "b" }, true)).toBeNull();
    expect(scheduler.reserveOutput("g:c", "text", balancedChatLimits, true)).toBeNull();
    first(false);
    scheduler.reserveOutput("g:c", "text", limits, true)!(true);
    now += 14999; expect(scheduler.reserveOutput("g:c", "text", { ...limits, exchangeId: "b" }, true)).toBeNull();
    now++; scheduler.reserveOutput("g:c", "text", { ...limits, exchangeId: "b" }, true)!(true);
    now += 15000; expect(scheduler.reserveOutput("g:c", "text", { ...limits, exchangeId: "c" }, true)).toBeNull();
    expect(scheduler.reserveOutput("g:c", "text", limits, false)).not.toBeNull();
    scheduler.stop();
  });
});
