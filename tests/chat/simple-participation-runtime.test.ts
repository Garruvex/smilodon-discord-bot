import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { freshDocument, memoryProvider, guildId, actorUserId } from "../helpers/settings-fixtures.js";
import { CharacterRuntime } from "../../src/application/chat/character-runtime.js";
import { AuthorizedConversationService as ChatConversationService } from "../helpers/authorized-conversation-service.js";
import { SqliteChatStateStore } from "../../src/infrastructure/persistence/sqlite-chat-state-store.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { createSqliteDatabaseConnection, type SqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { SimpleParticipationService } from "../../src/application/chat/simple-decision.js";
import { balancedChatLimits } from "../../src/application/chat/chat-scheduler.js";
import type { ChatConversationInput } from "../../src/application/chat/chat-conversation-service.js";
import type { ChatProvider, ChatRequest, ChatResponse, ChannelHistoryMessage } from "../../src/application/chat/chat-provider.js";
import type { DecisionContract } from "../../src/application/chat/participation-policy.js";

const channelId = "500000000000000001";
const connections: SqliteDatabaseConnection[] = [];
afterEach(() => { connections.splice(0).forEach((connection) => connection.close()); vi.restoreAllMocks(); });
const response = (text = "hey"): ChatResponse => ({ text, userMemoryActions: [], guildKnowledgeCandidates: [], sources: [], usage: null, webSearchUsed: false, generatedImages: [], ambientAction: "reply", reactionEmoji: null, historyReactions: [] });
const base = (): ChatRequest => ({ guildId, channelId, personality: "A fictional character who likes cats", personaLore: [], personaDrift: null,
  exampleExchanges: [{ tags: "chat", user: "hi", character: "hey" }], userCustomization: null, currentUser: { id: actorUserId, displayName: "Alice", roleNames: [] },
  mentionedUsers: [], recentHistory: [], memories: [], guildKnowledge: [], causalChains: [], message: "hey", replyChain: [], replyChainSummary: null,
  channelHistory: [], birthday: null, images: [], webSearchMode: "off", imageGenerationEnabled: false, includeSources: false, interaction: "direct_mention", botUserId: "bot" });
const message = (messageId: string, timestampMs: number, authorId: string, content: string, extra: Partial<ChannelHistoryMessage> = {}): ChannelHistoryMessage =>
  ({ messageId, timestampMs, authorId, authorDisplayName: authorId === "bot" ? "Bot" : authorId, content, imageCount: 0, ...extra });

type Logs = { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> };
type Fields = Record<string, unknown>;
const fieldsOf = (mock: ReturnType<typeof vi.fn>, event: string): Fields[] => (mock.mock.calls as unknown as [Fields][]).map(([fields]) => fields).filter((fields) => fields?.event === event);
interface Harness {
  profiles: ReturnType<typeof memoryProvider>; runtime: CharacterRuntime; logger: Logs; service: ChatConversationService;
  reply: ReturnType<typeof vi.fn>; generate: ReturnType<typeof vi.fn>; simpleCall: ReturnType<typeof vi.fn<(prompt: string) => Promise<unknown>>>;
  run: (overrides: Partial<ChatRequest> & Pick<Partial<ChatConversationInput>, "activityLimits"> & { current: ChannelHistoryMessage; history?: ChannelHistoryMessage[] }) => Promise<{ result: ChatResponse; deliver: ReturnType<typeof vi.fn> }>;
  setNow: (value: number) => void;
}
function setup(instance: DecisionContract = "simple", decide: (prompt: string) => unknown = (prompt) => prompt.includes("so be strict") ? { confirm: "yes" } : { action: "reply", emoji: "none" }): Harness {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "simple-runtime-"))); connections.push(connection);
  const repository = new SqliteMemoryRepository(connection.database); const doc = freshDocument(); doc.features.chatbot = true; doc.features.channelHistory = true; doc.channels.chatbot = [channelId];
  const profiles = memoryProvider(doc);
  const reply = vi.fn(() => Promise.resolve(response())); const generate = vi.fn(() => Promise.resolve({ text: "unused" }));
  const provider: ChatProvider = { reply, generateCharacterData: generate };
  const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  let now = 1;
  const runtime = new CharacterRuntime(profiles, repository, { generateCharacterData: generate }, provider, undefined, null, () => now, logger);
  now = 100_000;
  const simpleCall = vi.fn((prompt: string) => Promise.resolve(decide(prompt)));
  runtime.bindSimpleDecision(new SimpleParticipationService({ provider: { generateCharacterData: simpleCall }, source: "reply", endpoint: "reply-provider", model: "decision-model", reasoningEffort: "low" }), instance);
  const service = new ChatConversationService(provider, new SqliteChatStateStore(connection.database), new DefaultMemoryEngine(repository), undefined, undefined, undefined, null, null, null, null, null, null, null, null, runtime, () => now);
  const run: Harness["run"] = async (overrides) => {
    const deliver = vi.fn(() => Promise.resolve("sent")); const { current, history = [], ...rest } = overrides;
    for (const event of history) service.observe(guildId, channelId, event);
    const result = await service.run({ ...base(), message: current.content, interaction: "group_conversation", sourceMessageId: current.messageId, currentBurst: [current],
      currentEvent: { type: "message", messageId: current.messageId, authorId: current.authorId, channelId, timestampMs: current.timestampMs, replyToMessageId: current.replyToMessageId ?? null, mentionedUserIds: [] },
      channelHistory: history, channelHistoryEnabled: true, examplePool: [], loreChunks: [], currentUser: { id: current.authorId, displayName: current.authorDisplayName, roleNames: [] }, ...rest } as never, deliver);
    return { result, deliver };
  };
  return { profiles, runtime, logger, simpleCall, run, service, reply, generate, setNow: (value: number): void => { now = value; } };
}
const decisions = (logger: Logs): Fields[] => fieldsOf(logger.info, "chat.simple_decision");
const exclusions = (logger: Logs): Fields[] => fieldsOf(logger.debug, "chat.simple_exclusion");

describe("simple participation", () => {
  it("shows what it would do in preview and sends nothing, then delivers an admitted reply with preview off", async () => {
    for (const shadowMode of [true, false]) {
      const { profiles, reply, generate, run, logger, simpleCall, service } = setup();
      await profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId], shadowMode } });
      try {
        const { result, deliver } = await run({ current: message("current", 99_000, actorUserId, "anyone know a good cat toy") });
        expect(generate).not.toHaveBeenCalled();
        expect(simpleCall).toHaveBeenCalledTimes(2); // the decision, then the joining double check
        expect(decisions(logger)).toHaveLength(1);
        expect(decisions(logger)[0]).toMatchObject({ contract: "simple", contractSource: "instance", kind: "joining", basis: null, proposedAction: "reply", confirmation: { result: "yes" },
          preview: shadowMode, status: "valid", scoreKind: "unavailable", route: { source: "reply", model: "decision-model", reasoningEffort: "low" },
          admission: shadowMode ? "preview_not_sent" : "admitted", trial: shadowMode });
        expect(JSON.stringify(decisions(logger)[0])).not.toContain("cat toy");
        if (shadowMode) { expect(result.ambientAction).toBe("ignore"); expect(deliver).not.toHaveBeenCalled(); expect(reply).not.toHaveBeenCalled(); }
        else { expect(reply).toHaveBeenCalledOnce(); expect(deliver).toHaveBeenCalledOnce(); expect(result.ambientAction).toBe("reply"); }
      } finally { service.stopScheduling(); await service.drain(); }
    }
  });
  it("reacts with the chosen emoji and writes no reply text", async () => {
    const { profiles, reply, run, logger, service } = setup("simple", (prompt) => prompt.includes("so be strict") ? { confirm: "yes" } : { action: "react", emoji: "😂" });
    await profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    try {
      const { result, deliver } = await run({ current: message("current", 99_000, actorUserId, "my cat just fell off the shelf"), historyReactionsEnabled: true });
      expect(decisions(logger)[0]).toMatchObject({ proposedAction: "react", emoji: "😂", admission: "admitted" });
      expect(reply).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
      expect(result.reactionEmoji).toBe("😂"); expect(result.replyTargetMessageId).toBe("current");
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("hands a server emoji to Discord in its mention form", async () => {
    const { profiles, runtime, run, service } = setup("simple", (prompt) => prompt.includes("so be strict") ? { confirm: "yes" } : { action: "react", emoji: ":party_blob:" });
    runtime.bindEmojiSource(() => [{ id: "123456789012345678", name: "party_blob", animated: true }]);
    await profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    try {
      const { result } = await run({ current: message("current", 99_000, actorUserId, "we shipped it"), historyReactionsEnabled: true });
      expect(result.reactionEmoji).toBe("<a:party_blob:123456789012345678>");
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("lets an admitted brief acknowledgment through instead of rejecting it as a weak contribution", async () => {
    const { profiles, reply, run, service } = setup();
    await profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    reply.mockResolvedValue(response("thanks!"));
    try {
      const { result, deliver } = await run({ current: message("current", 99_000, actorUserId, "anyone know a good cat toy") });
      expect(deliver).toHaveBeenCalledOnce(); expect(result.text).toBe("thanks!");
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("keeps the decision as the only gate: an ignored message generates nothing", async () => {
    const { profiles, reply, run, service } = setup("simple", () => ({ action: "ignore", emoji: "none" }));
    await profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    try {
      const { deliver } = await run({ current: message("current", 99_000, actorUserId, "anyone know a good cat toy") });
      expect(reply).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("counts a delivered follow-up against that author's exchange limit", async () => {
    const { profiles, reply, run, logger, simpleCall, service, setNow } = setup();
    await profiles.update(guildId, { chatParticipation: { continuationEnabled: true } });
    const activityLimits = { ...balancedChatLimits, continuationPerExchange: 1, continuationIntervalMs: 15_000, exchangeId: `simple:${actorUserId}` };
    try {
      setNow(100_000);
      const human = message("ask", 90_000, actorUserId, "can you check the build"); const bot = message("answer", 95_000, "bot", "it passed", { replyToMessageId: "ask", replyToAuthorId: actorUserId });
      const first = await run({ interaction: "implicit_followup", activityLimits, current: message("one", 98_000, actorUserId, "and the lint?"), history: [human, bot] });
      expect(first.deliver).toHaveBeenCalledOnce();
      setNow(130_000);
      const second = await run({ interaction: "implicit_followup", activityLimits, current: message("two", 129_000, actorUserId, "and the tests?"), history: [human, bot, message("one", 98_000, actorUserId, "and the lint?")] });
      // The limit is known before any model call, so nothing is decided or generated.
      expect(second.deliver).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledTimes(1); expect(simpleCall).toHaveBeenCalledTimes(1);
      expect(exclusions(logger).map((entry) => entry.reason)).toEqual(["no_action_available"]);
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("classifies an unlinked message inside the idle window as an open-exchange follow-up and logs the basis", async () => {
    const { profiles, run, logger, service, setNow } = setup();
    await profiles.update(guildId, { chatParticipation: { continuationEnabled: true } });
    try {
      setNow(100_000);
      const human = message("ask", 90_000, actorUserId, "can you check the build"); const bot = message("answer", 95_000, "bot", "it passed", { replyToMessageId: "ask", replyToAuthorId: actorUserId });
      await run({ interaction: "implicit_followup", current: message("current", 98_000, actorUserId, "and the lint?"), history: [human, bot] });
      expect(decisions(logger)[0]).toMatchObject({ kind: "followup", basis: "open_exchange", proposedAction: "reply" });
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("double checks an unsolicited join, and a refusal or failed check means no action", async () => {
    for (const [confirm, admission, result] of [["no", "join_not_confirmed", "no"], ["maybe", "join_confirmation_failed", "failed"]] as const) {
      const { profiles, run, logger, simpleCall, service } = setup("simple", (prompt) => prompt.includes("so be strict") ? { confirm } : { action: "reply", emoji: "none" });
      await profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
      try {
        await run({ current: message("current", 99_000, actorUserId, "anyone know a good cat toy") });
        expect(simpleCall).toHaveBeenCalledTimes(2);
        expect(decisions(logger)[0]).toMatchObject({ kind: "joining", proposedAction: "reply", admission, confirmation: { result } });
      } finally { service.stopScheduling(); await service.drain(); }
    }
  });
  it("does not double check a follow-up and never asks about an ignored join", async () => {
    const { profiles, run, logger, simpleCall, service, setNow } = setup();
    await profiles.update(guildId, { chatParticipation: { continuationEnabled: true, spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    try {
      setNow(100_000);
      const human = message("ask", 90_000, actorUserId, "can you check the build"); const bot = message("answer", 95_000, "bot", "it passed", { replyToMessageId: "ask", replyToAuthorId: actorUserId });
      await run({ interaction: "implicit_followup", current: message("current", 98_000, actorUserId, "and the lint?"), history: [human, bot] });
      expect(simpleCall).toHaveBeenCalledOnce();
      expect(decisions(logger)[0]).toMatchObject({ kind: "followup", confirmation: null });
    } finally { service.stopScheduling(); await service.drain(); }
    const ignored = setup("simple", () => ({ action: "ignore", emoji: "none" }));
    await ignored.profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    try {
      await ignored.run({ current: message("current", 99_000, actorUserId, "anyone know a good cat toy") });
      expect(ignored.simpleCall).toHaveBeenCalledOnce();
      expect(decisions(ignored.logger)[0]).toMatchObject({ admission: "model_ignore", confirmation: null });
    } finally { ignored.service.stopScheduling(); await ignored.service.drain(); }
  });
  it("offers the Unicode set plus a capped sample of the server's own emoji, and only when a reaction is possible", async () => {
    const { profiles, runtime, run, logger, simpleCall, service } = setup();
    runtime.bindEmojiSource(() => Array.from({ length: 50 }, (_, index) => ({ id: String(5000 + index), name: `blob_${index}`, animated: false })));
    await profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    try {
      await run({ current: message("current", 99_000, actorUserId, "anyone know a good cat toy"), historyReactionsEnabled: true });
      expect(decisions(logger)[0]).toMatchObject({ emojiOptions: 8 + 20, availableReact: true });
      expect(simpleCall.mock.calls[0]![0]).toMatch(/:blob_\d+:/u);
      expect(simpleCall.mock.calls[0]![0]).not.toContain("5000");
    } finally { service.stopScheduling(); await service.drain(); }
    const quiet = setup();
    quiet.runtime.bindEmojiSource(() => [{ id: "1", name: "blob_1", animated: false }]);
    await quiet.profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    try {
      await quiet.run({ current: message("current", 99_000, actorUserId, "anyone know a good dog toy"), historyReactionsEnabled: false });
      expect(decisions(quiet.logger)[0]).toMatchObject({ emojiOptions: 0, availableReact: false });
      expect(quiet.simpleCall.mock.calls[0]![0]).not.toContain("blob_1");
    } finally { quiet.service.stopScheduling(); await quiet.service.drain(); }
  });
  it("skips the model for a disabled kind and a reply to another human, and reports exclusions at debug level only", async () => {
    const { profiles, run, logger, simpleCall, service } = setup();
    await profiles.update(guildId, { chatParticipation: { continuationEnabled: true } });
    try {
      await run({ current: message("a", 99_000, actorUserId, "random chatter") });
      const bob = message("bob", 98_000, "bob", "hey alice");
      await run({ interaction: "implicit_followup", current: message("b", 99_500, actorUserId, "yes sure", { replyToMessageId: "bob", replyToAuthorId: "bob" }), history: [bob] });
      expect(simpleCall).not.toHaveBeenCalled(); expect(decisions(logger)).toHaveLength(0);
      expect(exclusions(logger).map((entry) => entry.reason)).toEqual(["joining_disabled", "addressed_elsewhere"]);
      expect(fieldsOf(logger.info, "chat.simple_exclusion")).toHaveLength(0);
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("leaves explicit requests on their direct path and legacy channels on the legacy contract", async () => {
    const direct = setup();
    await direct.profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    try {
      const { deliver } = await direct.run({ interaction: "direct_mention", current: message("ping", 99_000, actorUserId, "<@bot> hello") });
      expect(direct.simpleCall).not.toHaveBeenCalled(); expect(deliver).toHaveBeenCalled();
    } finally { direct.service.stopScheduling(); await direct.service.drain(); }
    const legacy = setup("legacy");
    await legacy.profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    try {
      await legacy.run({ current: message("current", 99_000, actorUserId, "anyone know a good cat toy") });
      expect(legacy.simpleCall).not.toHaveBeenCalled(); expect(decisions(legacy.logger)).toHaveLength(0);
    } finally { legacy.service.stopScheduling(); await legacy.service.drain(); }
  });
  it("tells the operator when preview is on and that thresholds need a native score", async () => {
    const { runtime, profiles } = setup("simple");
    expect(runtime.describeContract(profiles.current(), channelId).notes).toEqual([]);
    await profiles.update(guildId, { chatParticipation: { shadowMode: true, simpleActionThresholds: { followup: 0.7 } } });
    expect(runtime.describeContract(profiles.current(), channelId).notes).toEqual(["trial", "threshold_ignored"]);
    const legacy = setup("legacy");
    expect(legacy.runtime.describeContract(legacy.profiles.current(), channelId).notes).toEqual([]);
  });
  it("resolves the contract per channel and per guild before the instance default", async () => {
    const { profiles, run, logger, simpleCall, service } = setup("legacy");
    await profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId], decisionContract: "simple" } });
    try {
      await run({ current: message("a", 99_000, actorUserId, "anyone know a good cat toy") });
      expect(decisions(logger)[0]).toMatchObject({ contract: "simple", contractSource: "guild" });
      await profiles.update(guildId, { chatParticipation: { channelOverrides: { [channelId]: { decisionContract: "legacy" } } } });
      simpleCall.mockClear();
      await run({ current: message("b", 99_100, actorUserId, "anyone know a better cat toy") });
      expect(simpleCall).not.toHaveBeenCalled();
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("applies the simple-action threshold only to a native score and records a failed call as unavailable, not as ignore", async () => {
    const { profiles, run, logger, service } = setup("simple", () => { throw new Error("provider down"); });
    await profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
    try {
      const { deliver } = await run({ current: message("a", 99_000, actorUserId, "anyone know a good cat toy") });
      expect(deliver).not.toHaveBeenCalled();
      expect(decisions(logger)[0]).toMatchObject({ status: "failed", proposedAction: null });
      expect(decisions(logger)[0]).not.toMatchObject({ admission: "model_ignore" });
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("steers an admitted reply with the held thought's stance and length, never with model-written text", async () => {
    const answer = (prompt: string): unknown => prompt.includes("Imagine the bot replies") ? { stance: "joke", length: "one_line" } :
      prompt.includes("so be strict") ? { confirm: "yes" } : { action: "reply", emoji: "none" };
    const { profiles, reply, run, service } = setup("simple", answer);
    await profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] }, character: { enabled: true, modules: { thoughts: { enabled: true, shadow: false } } } });
    try {
      await run({ current: message("current", 99_000, actorUserId, "my cat knocked over the plant again") });
      const context = JSON.stringify((reply.mock.calls[0] as unknown as [ChatRequest])[0].characterContext);
      expect(context).toContain("Planned approach: a one-line reply, with a light joke.");
      expect(context).toContain("You decided to join this conversation");
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("waits out one idle window before a linked follow-up into an exchange from before the restart", async () => {
    const { profiles, run, logger, simpleCall, service, setNow } = setup();
    await profiles.update(guildId, { chatParticipation: { continuationEnabled: true } });
    try {
      const ask = message("ask", 0, actorUserId, "can you check the build"); const answer = message("answer", 0, "bot", "it passed", { replyToMessageId: "ask", replyToAuthorId: actorUserId });
      setNow(100_000);
      await run({ interaction: "implicit_followup", current: message("early", 98_000, actorUserId, "and the lint?", { replyToMessageId: "answer", replyToAuthorId: "bot" }), history: [ask, answer] });
      expect(simpleCall).not.toHaveBeenCalled();
      expect(exclusions(logger).map((entry) => entry.reason)).toEqual(["exchange_restart_wait"]);
      setNow(200_000);
      await run({ interaction: "implicit_followup", current: message("late", 198_000, actorUserId, "and the tests?", { replyToMessageId: "answer", replyToAuthorId: "bot" }), history: [ask, answer] });
      expect(decisions(logger)[0]).toMatchObject({ kind: "followup", basis: "linked" });
    } finally { service.stopScheduling(); await service.drain(); }
  });
  it("holds an ignored thought, offers it to the next decision in the same scope and not when shadow is on", async () => {
    let held = false;
    const answer = (prompt: string): unknown => prompt.includes("Imagine the bot replies") ? { stance: "agree", length: "one_line" } : { action: "ignore", emoji: "none" };
    const run1 = setup("simple", answer);
    await run1.profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] }, character: { enabled: true, modules: { thoughts: { enabled: true, shadow: false } } } });
    try {
      await run1.run({ current: message("a", 99_000, actorUserId, "cats are better than dogs") });
      expect(decisions(run1.logger)[0]).toMatchObject({ thought: { outcome: "held", stance: "agree", heldOffered: false } });
      run1.simpleCall.mockClear(); run1.setNow(130_000);
      await run1.run({ current: message("b", 129_500, actorUserId, "honestly cats win") , history: [message("a", 99_000, actorUserId, "cats are better than dogs")] });
      held = run1.simpleCall.mock.calls.some(([prompt]) => String(prompt).includes("held back from replying"));
      expect(held).toBe(true); expect(decisions(run1.logger)[1]).toMatchObject({ thought: { heldOffered: true } });
    } finally { run1.service.stopScheduling(); await run1.service.drain(); }
    const shadow = setup("simple", answer);
    await shadow.profiles.update(guildId, { chatParticipation: { spontaneousEnabled: true, spontaneousChannelIds: [channelId] }, character: { enabled: true, modules: { thoughts: { enabled: true, shadow: true } } } });
    try {
      await shadow.run({ current: message("a", 99_000, actorUserId, "cats are better than dogs") });
      expect(decisions(shadow.logger)[0]).toMatchObject({ thought: { outcome: "shadow", stance: "agree" } });
      shadow.setNow(130_000);
      await shadow.run({ current: message("b", 129_500, actorUserId, "honestly cats win"), history: [message("a", 99_000, actorUserId, "cats are better than dogs")] });
      expect(shadow.simpleCall.mock.calls.some(([prompt]) => String(prompt).includes("held back from replying"))).toBe(false);
    } finally { shadow.service.stopScheduling(); await shadow.service.drain(); }
  });
});
