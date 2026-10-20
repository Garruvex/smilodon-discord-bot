import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatConversationService, type ChatConversationInput } from "../../src/application/chat/chat-conversation-service.js";
import type { ChatRequest, ChatResponse } from "../../src/application/chat/chat-provider.js";
import { CharacterRuntime } from "../../src/application/chat/character-runtime.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import { SqliteChatStateStore } from "../../src/infrastructure/persistence/sqlite-chat-state-store.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import { buildChatContext } from "../../src/infrastructure/chat/chat-structured-output.js";
import { guardedEvent, guardedFixture } from "../helpers/guarded-context-fixture.js";
import { freshDocument, guildId, memoryProvider } from "../helpers/settings-fixtures.js";
import { decisionProposal, decisionResponse } from "../helpers/conversation-decision-fixtures.js";

const channelId = "500000000000000001";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function setup(now = 5000, originalAuthor = "alice"): Promise<{
  service: ChatConversationService; fixture: ReturnType<typeof guardedFixture>; input: ChatConversationInput;
  reply: ReturnType<typeof vi.fn<(request: ChatRequest) => Promise<ChatResponse>>>;
  engine: DefaultMemoryEngine; runtime: CharacterRuntime; state: SqliteChatStateStore;
  decision: { generateCharacterData: ReturnType<typeof vi.fn> };
}> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "guarded-turn-")));
  const repository = new SqliteMemoryRepository(connection.database); const state = new SqliteChatStateStore(connection.database);
  const document = freshDocument(); document.features.chatbot = true; document.features.channelHistory = true; document.channels.chatbot = [channelId];
  const profiles = memoryProvider(document);
  await profiles.update(guildId, { character: { context: { ...profiles.current().character!.context, enabled: true, retrievalMode: "eligible_count" } },
    chatParticipation: { continuationEnabled: true, spontaneousEnabled: true, spontaneousChannelIds: [channelId] } });
  const reply = vi.fn((_request: ChatRequest) => Promise.resolve(decisionResponse({ text: "The carburetor needs a richer mixture at full throttle.", ambientAction: "reply", responseIntent: "answer" })));
  const decision = { generateCharacterData: vi.fn(() => Promise.resolve(decisionProposal({
    recipientEvidence: ["current"], target: "current", boundary: "earlier",
    contribution: { text: "A carburetor answer", adds: "Mixture adjustment", label: "answer", motivation: 0.95, sourceMessageId: "current", recipientId: "alice" },
  }))) };
  const runtime = new CharacterRuntime(profiles, repository, null, { reply }, decision, null, () => now);
  const engine = new DefaultMemoryEngine(repository, null, null, undefined, null, null, null, () => true);
  const service = new ChatConversationService({ reply }, state, engine, undefined, undefined, undefined, null, null, null, null, null, null, null, null, runtime, () => now);
  cleanups.push(async () => { service.stopScheduling(); await service.drain(); runtime.stop(); connection.close(); });
  const fixture = guardedFixture(guardedEvent("question", 1000, "Explain the carburetor mixture adjustment", originalAuthor), { guildId, channelId });
  const previous = await GuardedConversationContext.open(fixture.port, { count: 40, budget: 12000, burstIds: [] });
  fixture.sources.set("answer", { event: { ...guardedEvent("answer", 2000, "Which throttle range?", "bot", { replyToMessageId: "question" }), channelId }, origin: "chat", provenance: previous.provenance("Which throttle range?") });
  fixture.add(guardedEvent("current", 4000, "@bot", "alice", { replyToMessageId: "answer" })); fixture.port.sourceMessageId = "current";
  fixture.port.actorId = "alice";
  const input: ChatConversationInput = { guildId, channelId, sourceMessageId: "current", personality: "A dry, playful mechanic",
    personaDrift: "SECRET_DRIFT", loreChunks: [], examplePool: [], currentUser: { id: "alice", displayName: "alice", roleNames: [] }, mentionedUsers: [],
    message: "UNTRUSTED_SYNTHETIC_INPUT", replyChain: [], channelHistory: [], images: [], includeSources: false,
    webSearchMode: "auto", imageGenerationEnabled: true, toolsEnabled: true, triggerMode: "direct", botUserId: "bot",
    guardedContextPort: fixture.port, guardedContextPolicy: { count: 40, budget: 12000 }, channelHistoryEnabled: true };
  return { service, fixture, input, reply, engine, runtime, state, decision };
}

describe("guarded turn acceptance", () => {
  it.each(["accepted", "cross_participant", "missing_evidence", "other_recipient", "private_source", "low_confidence", "decision_failed"] as const)("handles a sixteen-minute correction with guarded evidence: %s", async (scenario) => {
    const { service, fixture, input, reply, runtime, decision } = await setup(963000, scenario === "cross_participant" ? "bob" : "alice");
    const correction = guardedEvent("current", 962000, "我是在修你ㄟ 你剛剛壞掉了不回他\n跟大番薯沒關西");
    fixture.add(correction);
    // The local episode window is empty, as after restart or a long gap.
    expect(runtime.couldBeAddressed(guildId, channelId, correction, [], "bot")).toBe(true);
    const proposal = decisionProposal({ recipientEvidence: ["question", "answer", "current"] });
    if (scenario === "missing_evidence") proposal.recipientEvidence = ["current"];
    if (scenario === "low_confidence") proposal.recipientConfidence = 0.2;
    if (scenario === "other_recipient") fixture.add({ ...correction, replyToMessageId: "question" });
    if (scenario === "private_source") fixture.denied.add("question");
    if (scenario === "decision_failed") decision.generateCharacterData.mockRejectedValue(new Error("unavailable"));
    else decision.generateCharacterData.mockResolvedValue(proposal);
    await service.run({ ...input, triggerMode: "continuation" }, (response) => Promise.resolve(response.text)).catch((error: unknown) => {
      expect(error).toBeInstanceOf(SocialOutputSuppressed);
    });
    if (scenario === "accepted" || scenario === "cross_participant") expect(reply).toHaveBeenCalledOnce();
    else expect(reply).not.toHaveBeenCalled();
  });
  it("skips redundant saved-session reads when both sides already exist in guarded history", async () => {
    const { service, fixture, input, reply, state } = await setup();
    await state.commitSuccessfulExchange({ guildId, userId: "alice", channelId, sourceMessageId: "question",
      userMessage: "Explain the carburetor mixture adjustment", assistantMessage: "Which throttle range?", assistantMessageIds: ["answer"],
      contextProvenance: fixture.sources.get("answer")!.provenance, actions: [], now: 3000 });
    const sessions = vi.spyOn(GuardedConversationContext.prototype, "sessions");
    try {
      await service.run(input, (response) => Promise.resolve(response.text));
      expect(sessions).toHaveBeenCalledExactlyOnceWith([]);
      expect(reply).toHaveBeenCalledOnce();
      expect(reply.mock.calls[0]![0].recentHistory).toEqual([]);
      expect(buildChatContext(reply.mock.calls[0]![0])).toContain("Which throttle range?");
    } finally { sessions.mockRestore(); }
  });
  it("rejects a mismatched source frame before model work", async () => {
    const { service, input, fixture, reply } = await setup();
    fixture.port.channelId = "another-channel";
    await expect(service.run(input, (response) => Promise.resolve(response.text))).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(reply).not.toHaveBeenCalled();
  });

  it("clears primary history even if durable context cleanup throws synchronously", async () => {
    const { service, state } = await setup();
    await state.commitSuccessfulExchange({ guildId, userId: "alice", channelId, userMessage: "question", assistantMessage: "answer", actions: [], now: 5000 });
    service.bindContextForgetRecorder(() => { throw new Error("storage unavailable"); });
    await expect(service.forgetConversation(guildId, "alice")).rejects.toThrow("durable context invalidation failed");
    expect((await state.load(guildId, "alice", channelId, 5001)).exchanges).toEqual([]);
  });

  it.each([
    ["direct_mention", "direct"], ["explicit_reply", "direct"], ["bare_ping", "direct"], ["name_address", "ambient"],
    ["implicit_followup", "continuation"], ["group_conversation", "spontaneous"], ["reaction", "reaction"],
  ] as const)("retains the authorized conversation for %s", async (interactionMode, triggerMode) => {
    const { service, fixture, input, reply } = await setup();
    if (triggerMode === "reaction") { fixture.port.sourceMessageId = "answer"; fixture.port.actorId = null;
      input.currentEvent = { type: "reaction_snapshot", channelId, targetMessageId: "answer", targetAuthorId: "bot", observedAt: 5000,
        complete: true, exactReactionTimes: "unknown", reactions: [{ emoji: "👍", emojiId: null, actorIds: ["alice"] }] };
      input.sourceMessageId = "answer";
    }
    const sent = vi.fn((response: ChatResponse) => { response.characterDeliveryProof = [{ messageId: "delivered", content: response.text }]; return Promise.resolve(response.text); });
    const response = await service.run({ ...input, interactionMode, triggerMode }, sent);
    expect(reply).toHaveBeenCalledOnce(); expect(sent).toHaveBeenCalledOnce();
    const request = reply.mock.calls[0]![0];
    expect([...request.replyChain, ...request.channelHistory].map((event) => event.messageId)).toContain("question");
    expect(buildChatContext(request)).toContain("Explain the carburetor");
    expect(buildChatContext(request)).not.toContain("SECRET_DRIFT"); expect(buildChatContext(request)).not.toContain("UNTRUSTED_SYNTHETIC");
    expect(response.contextProvenance?.coverage).toBe("complete");
  });

  it("keeps bare pings contextual and lets personality produce a playful social reply", async () => {
    const { service, input, reply } = await setup();
    reply.mockImplementation((request) => {
      expect(request.characterContext?.some((entry) => entry.text.includes("earlier substantive request"))).toBe(true);
      expect(request.personality).toContain("playful");
      return Promise.resolve(decisionResponse({ text: "You rang? The carburetor is still waiting.", responseIntent: "social", ambientAction: "reply" }));
    });
    const result = await service.run({ ...input, interactionMode: "bare_ping", allowSilentDirect: true }, (response) => Promise.resolve(response.text));
    expect(result.text).toContain("You rang?"); expect(result.conversationDecision?.decision.action).toBe("reply");
  });

  it("treats an unlinked bare ping as a reference to an older eligible request", async () => {
    const { service, fixture, input, reply } = await setup();
    fixture.sources.get("current")!.event.replyToMessageId = null;
    fixture.sources.delete("answer");
    fixture.sources.get("question")!.event.timestampMs = 0;
    reply.mockImplementation((request) => {
      expect(request.message).toBe("@bot"); expect(request.replyChain).toEqual([]);
      expect(request.channelHistory.map((event) => event.messageId)).toContain("question");
      return Promise.resolve(decisionResponse({ text: "For the earlier carburetor question, adjust the mixture first.",
        responseIntent: "answer", referentSourceIds: ["question"], ambientAction: "reply" }));
    });
    const result = await service.run({ ...input, interactionMode: "bare_ping" }, (response) => Promise.resolve(response.text));
    expect(result.conversationDecision?.decision.referentSourceIds).toEqual(["question"]);
  });

  it("keeps repeated-social-ping protection after contextual interpretation", async () => {
    const { service, fixture, input, reply } = await setup();
    reply.mockResolvedValue(decisionResponse({ text: "You rang?", responseIntent: "social", ambientAction: "reply" }));
    const sent = vi.fn((response: ChatResponse) => Promise.resolve(response.text));
    await service.run(input, sent);
    fixture.add(guardedEvent("second", 5000, "@bot")); fixture.port.sourceMessageId = "second";
    const second = await service.run({ ...input, sourceMessageId: "second" }, sent);
    expect(reply).toHaveBeenCalledTimes(2); expect(sent).toHaveBeenCalledOnce();
    expect(second.conversationDecision).toMatchObject({ status: "denied", decision: { reasonCode: "duplicate_ping", action: "silent" } });
  });

  it("never sends unreadable reaction-target content to the model", async () => {
    const { service, fixture, input, reply } = await setup();
    fixture.sources.get("answer")!.provenance = null;
    fixture.sources.get("answer")!.event.content = "PROTECTED_LEGACY_TARGET";
    fixture.port.sourceMessageId = "answer"; fixture.port.actorId = null;
    await expect(service.run({ ...input, triggerMode: "reaction", sourceMessageId: "answer", message: "PROTECTED_LEGACY_TARGET",
      currentEvent: { type: "reaction_snapshot", channelId, targetMessageId: "answer", targetAuthorId: "bot", observedAt: 5000,
        complete: true, exactReactionTimes: "unknown", reactions: [{ emoji: "👍", emojiId: null, actorIds: ["alice"] }] },
    }, (response) => Promise.resolve(response.text))).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(reply).not.toHaveBeenCalled();
  });

  it("never calls memory recall or learned-character context on the guarded text path", async () => {
    const { service, input, engine, runtime } = await setup();
    const recall = vi.spyOn(engine, "recall").mockRejectedValue(new Error("SECRET_MEMORY"));
    const contribute = vi.spyOn(runtime.registry, "contribute").mockRejectedValue(new Error("SECRET_CHARACTER"));
    await service.run({ ...input, interactionMode: "direct_mention" }, (response) => Promise.resolve(response.text));
    expect(recall).not.toHaveBeenCalled(); expect(contribute).not.toHaveBeenCalled();
  });

  it("rechecks source access after generation and prevents all delivery", async () => {
    const { service, fixture, input, reply } = await setup();
    reply.mockImplementation(() => { fixture.denied.add("question"); return Promise.resolve(decisionResponse()); });
    const send = vi.fn(() => Promise.resolve("sent"));
    await expect(service.run(input, send)).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(send).not.toHaveBeenCalled();
  });

  it("rechecks source access before provider retries", async () => {
    const { service, fixture, input, reply } = await setup();
    const external = vi.fn();
    reply.mockImplementation(async (request) => {
      fixture.denied.add("question"); await request.beforeModelAttempt?.(); external(); return decisionResponse();
    });
    await expect(service.run(input, (response) => Promise.resolve(response.text))).rejects.toBeInstanceOf(SocialOutputSuppressed);
    expect(external).not.toHaveBeenCalled();
  });

  it("records a complete session that can be revalidated on the next turn", async () => {
    const { service, fixture, input, state } = await setup();
    await service.run(input, (response) => {
      const text = response.text;
      fixture.sources.set("delivered", { event: { ...guardedEvent("delivered", 4500, text, "bot", { replyToMessageId: "current" }), channelId },
        origin: "chat", provenance: response.contextLease!.provenance(text) });
      response.characterDeliveryProof = [{ messageId: "delivered", content: text }]; return Promise.resolve(text);
    });
    const stored = await state.load(guildId, "alice", channelId, 5000);
    expect(stored.exchanges[0]?.contextProvenance?.coverage).toBe("complete");
    fixture.add(guardedEvent("next", 5000, "next question")); fixture.port.sourceMessageId = "next";
    const next = await GuardedConversationContext.open(fixture.port, { count: 40, budget: 12000, burstIds: [] });
    expect(await next.sessions(stored.exchanges)).toHaveLength(1);
  });
});
