import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Collection, type Client, type GuildMember, type Message } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BehaviorDispatcher } from "../../src/application/behaviors/behavior-dispatcher.js";
import { BehaviorRegistry } from "../../src/application/behaviors/behavior-registry.js";
import { BehaviorEvent } from "../../src/application/behaviors/behavior.js";
import { CharacterRuntime } from "../../src/application/chat/character-runtime.js";
import { ChatConversationService } from "../../src/application/chat/chat-conversation-service.js";
import { GuardedConversationContext } from "../../src/application/chat/guarded-conversation-context.js";
import type { ChatRequest, ChatResponse } from "../../src/application/chat/chat-provider.js";
import type { PersonaSource } from "../../src/application/chat/persona-source.js";
import { createGuardedMemoryEngine } from "../../src/application/context/guarded-memory-gateway.js";
import { guardModelTransport } from "../../src/application/context/guarded-model-transport.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import { AmbientChatBehavior } from "../../src/infrastructure/discord/behaviors/ambient-chat-behavior.js";
import { MentionChatBehavior } from "../../src/infrastructure/discord/behaviors/mention-chat-behavior.js";
import { ProactiveChatBehavior } from "../../src/infrastructure/discord/behaviors/proactive-chat-behavior.js";
import { ReactionReplyScheduler } from "../../src/infrastructure/discord/behaviors/reaction-reply-scheduler.js";
import { SocialChatEligibility } from "../../src/infrastructure/discord/behaviors/social-chat-eligibility.js";
import { ChatTurnSupport } from "../../src/infrastructure/discord/behaviors/chat-turn-support.js";
import { SqliteChatStateStore } from "../../src/infrastructure/persistence/sqlite-chat-state-store.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { SqliteMessageOriginStore } from "../../src/infrastructure/persistence/sqlite-message-origin-store.js";
import { SqliteMessageReactionWatchStore } from "../../src/infrastructure/persistence/sqlite-message-reaction-watch-store.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import { decisionProposal, decisionResponse } from "../helpers/conversation-decision-fixtures.js";
import { contextualProposal } from "../helpers/contextual-decision-fixtures.js";
import { captureDiagnosticLogger } from "../helpers/diagnostic-logger.js";
import { freshDocument, guildId, memoryProvider } from "../helpers/settings-fixtures.js";

const channelId = "500000000000000001"; const botId = "700000000000000001"; const actorId = "800000000000000001";
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1792526400000); });
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
type Strategy = "legacy_context" | "guarded_legacy_decision" | "contextual";
type Mode = "mention" | "reply" | "ping" | "name" | "followup" | "group" | "reaction";

// Only Discord transport and structured providers are simulated. Dispatch,
// adapters, access, profile parsing, provenance, lease, runtime, policy,
// scheduler, delivery support and persistence are the production components.
async function setup(strategy: Strategy, mode: Mode, behavior: "reply" | "react" | "failed" | "invalid_generation" | "revoked" | "shadow" = "reply", actorCount = 1, historyEnabled = true): Promise<{
  execute: () => Promise<void>; records: Record<string, unknown>[];
  decision: ReturnType<typeof vi.fn<(prompt: string) => Promise<unknown>>>;
  reply: ReturnType<typeof vi.fn<(request: ChatRequest) => Promise<ChatResponse>>>;
  sent: { target: string; content: string }[]; reacted: string[]; source: Message;
  origins: SqliteMessageOriginStore; state: SqliteChatStateStore; fetch: ReturnType<typeof vi.fn>; profiles: ReturnType<typeof memoryProvider>;
}> {
  const connection = createSqliteDatabaseConnection(mkdtempSync(join(tmpdir(), "adapter-paths-")));
  const repository = new SqliteMemoryRepository(connection.database); const origins = new SqliteMessageOriginStore(connection.database);
  const watches = new SqliteMessageReactionWatchStore(connection.database); const state = new SqliteChatStateStore(connection.database);
  const document = freshDocument(); document.branding.displayName = "Pinecone";
  Object.assign(document.features, { chatbot: true, channelHistory: historyEnabled, ambientReplies: true, reactionReplies: true, historyReactions: true, music: false });
  document.roles.chatbot = [guildId]; document.roles.restricted = ["restricted"];
  document.channels.chatbot = [channelId]; document.chat.toolCallingEnabled = false; document.chat.webSearchMode = "off";
  document.chat.participation.continuationEnabled = true; document.chat.participation.spontaneousEnabled = true;
  document.chat.participation.spontaneousChannelIds = [channelId];
  document.chat.participation.messagesPerDecision = 1;
  document.chat.participation.flowVersion = strategy === "contextual" ? "contextual_v1" : "legacy";
  document.chat.participation.shadowMode = behavior === "shadow";
  document.character.context.enabled = true; document.character.context.retrievalMode = strategy === "legacy_context" ? "legacy" : "eligible_count";
  const profiles = memoryProvider(document);
  const config = { ownerUserIds: new Set<string>(), chat: null, chatDelivery: { maxGeneratedImageAggregateBytes: 1000000 } } as unknown as ApplicationConfiguration;
  const { logger, records } = captureDiagnosticLogger();
  const eligibility = new SocialChatEligibility(config, profiles, origins, null); eligibility.bindGuardedForgetPolicy(() => Promise.resolve(false));
  const members = new Map<string, GuildMember>();
  const messages = new Collection<string, Message>(); const sent: { target: string; content: string }[] = []; const reacted: string[] = [];
  const guild = { id: guildId, members: { me: null, fetch: vi.fn((value: string | { user: string }) => Promise.resolve(members.get(typeof value === "string" ? value : value.user) ?? null)) } };
  const fetch = vi.fn((value: string | { message?: string; before?: string; after?: string; limit?: number }) => {
    if (typeof value === "string" || value.message) return Promise.resolve(messages.get(typeof value === "string" ? value : value.message!) ?? null);
    const before = value.before ? messages.get(value.before)?.createdTimestamp ?? Infinity : Infinity;
    const after = value.after ? messages.get(value.after)?.createdTimestamp ?? -Infinity : -Infinity;
    return Promise.resolve(new Collection([...messages].filter(([, item]) => item.createdTimestamp < before && item.createdTimestamp > after)
      .sort((a, b) => b[1].createdTimestamp - a[1].createdTimestamp).slice(0, value.limit ?? 100)));
  });
  const channel = { id: channelId, guildId, nsfw: false, isThread: (): boolean => false, isTextBased: (): boolean => true, isDMBased: (): boolean => false,
    messages: { cache: new Collection<string, Message>(), fetch }, sendTyping: (): Promise<void> => Promise.resolve(),
    send: (payload: { content: string }): Promise<Message> => {
      sent.push({ target: "current", content: payload.content });
      return Promise.resolve(makeMessage(`delivered-${sent.length}`, payload.content, botId, Date.now()));
    } };
  const makeMessage = (id: string, content: string, authorId = actorId, at = Date.now(), replyTo?: string): Message => {
    const user = { id: authorId, username: authorId, displayName: authorId, bot: authorId === botId, send: (): Promise<void> => Promise.resolve() };
    if (!members.has(authorId)) members.set(authorId, { id: authorId, user, displayName: authorId, guild, nickname: null,
      roles: { cache: new Collection() }, permissions: { has: () => false } } as unknown as GuildMember);
    const mentions = new Collection(content.includes(`<@${botId}>`) ? [[botId, { ...user, id: botId, bot: true }]] : []);
    const message = { id, content, guildId, channelId, guild, channel, client: { user: { id: botId } }, createdTimestamp: at,
      author: user, member: members.get(authorId), inGuild: () => true, attachments: new Collection(),
      reference: replyTo ? { messageId: replyTo, channelId } : null, mentions: { users: mentions, members: new Collection(), repliedUser: null },
      reactions: { cache: new Collection() }, react: (emoji: string) => { reacted.push(`${id}:${emoji}`); return Promise.resolve(); },
      reply: (payload: { content: string }) => {
        sent.push({ target: id, content: payload.content });
        return Promise.resolve(makeMessage(`delivered-${sent.length}`, payload.content, botId, Date.now(), id));
      },
    } as unknown as Message;
    messages.set(id, message); return message;
  };
  const support = new ChatTurnSupport(logger, eligibility, origins);
  const gap = strategy === "legacy_context" ? 3000 : 16 * 60000;
  const original = makeMessage("question", "Please check the second test option.", actorId, Date.now() - gap);
  if (strategy === "legacy_context") channel.messages.cache.set(original.id, original);
  const previous = await GuardedConversationContext.open(support.createContextPort(original), { count: 40, budget: 12000, burstIds: [] });
  const bot = makeMessage("answer", "Would you like the first or second option?", botId, Date.now() - gap + 1000, original.id);
  await origins.record({ messageId: bot.id, guildId, channelId, origin: "chat", sourceMessageId: original.id, createdAt: bot.createdTimestamp,
    contextProvenance: previous.provenance(bot.content) });
  const denied = makeMessage("private", "PRIVATE_SOURCE_TEXT", "denied", Date.now() - 500);
  members.get(denied.author.id)!.roles.cache.set("restricted", { id: "restricted", name: "restricted" } as never);
  if (mode === "ping") makeMessage("pending", "Please explain the second option details.", actorId, Date.now() - 250);
  const text = mode === "mention" ? `<@${botId}> Please check the second option.` : mode === "ping" ? `<@${botId}>` :
    mode === "name" ? "Pinecone, please check the second option." : mode === "group" ? "The game update is out. Anyone tried it?" : "The second one";
  const source = mode === "reaction" ? bot : makeMessage("current", text, actorId, Date.now(), mode === "reply" ? bot.id : undefined);
  if (mode === "reaction") {
    const actors = [actorId];
    for (let index = 1; index < actorCount; index++) { const id = `reactor-${index}`; actors.push(id); makeMessage(`reactor-source-${index}`, "hello", id, Date.now() - 250); }
    source.reactions.cache.set("👍", { emoji: { id: null, name: "👍" },
      users: { fetch: () => Promise.resolve(new Collection(actors.map((id) => [id, members.get(id)!.user]))) } } as never);
  }
  const decision = vi.fn((prompt: string) => {
    expect(prompt).not.toContain("PRIVATE_SOURCE_TEXT");
    if (behavior === "failed") return Promise.reject(new Error("Synthetic provider failure"));
    const reaction = mode === "reaction"; const target = reaction ? bot.id : source.id;
    if (strategy === "contextual" || reaction) return Promise.resolve(contextualProposal({
      relationship: reaction || mode === "group" ? "group" : "followup", referent: mode === "group" ? "self_contained" : "context_linked",
      intent: behavior === "react" ? "social" : reaction || mode === "group" ? "contribute" : "answer",
      action: behavior === "react" ? "react" : "reply", reaction: behavior === "react" ? "👍" : null,
      linkKey: reaction ? "reaction" : mode === "group" ? null : "speaker_1", recipientEvidence: [target],
      ...(behavior === "react" ? { contribution: null } : {}),
    }));
    return Promise.resolve(decisionProposal({ target, recipientEvidence: [source.id, original.id, bot.id],
      addressing: mode === "group" ? "others" : "continuing", contribution: { text: "A concrete second-option result", adds: "The requested result",
        label: "answer", motivation: 0.95, sourceMessageId: target, recipientId: actorId } }));
  });
  const reply = vi.fn((request: ChatRequest) => {
    expect(JSON.stringify(request.channelHistory)).not.toContain("PRIVATE_SOURCE_TEXT");
    if (mode === "ping" && historyEnabled) expect(request.channelHistory.some((event) => event.messageId === "pending")).toBe(true);
    expect(request.contextLease).toBeDefined();
    if (strategy === "contextual" && decision.mock.calls.length) {
      const projection = JSON.parse(decision.mock.calls[0]![0].split("Data: ")[1]!) as { events: { evidenceKey: string; content: string }[] };
      const generation = [...request.channelHistory, ...request.replyChain, ...(request.currentBurst ?? [])];
      for (const event of projection.events) expect(generation.find((source) => source.messageId === event.evidenceKey)?.content).toBe(event.content);
    }
    if (behavior === "revoked") members.get(actorId)!.roles.cache.set("restricted", { id: "restricted", name: "restricted" } as never);
    return Promise.resolve(decisionResponse({ text: "The second option is ready for testing.", responseIntent: "answer", ambientAction: "reply",
      ...(behavior === "invalid_generation" ? { referentSourceIds: ["private"], reactionEmoji: "👍", historyReactions: [{ messageId: "private", emoji: "👍" }] } : {}) }));
  });
  const provider = guardModelTransport({ reply, generateCharacterData: decision }, logger);
  const runtime = new CharacterRuntime(profiles, repository, null, provider, provider, null, Date.now, logger);
  const memory = createGuardedMemoryEngine(repository, null, null, undefined, null, null, null, () => true);
  const service = new ChatConversationService(provider, state, memory, undefined, undefined, undefined, null, null, null, logger, null, null, null, null, runtime);
  const persona: PersonaSource = { resolve: () => Promise.resolve({ personality: "A fictional test bot", personaDrift: null, examplePool: [], loreChunks: [], personalitySourceHash: "test" }) };
  const ambient = new AmbientChatBehavior(() => botId, config, profiles, service, persona, logger, watches, null, eligibility, origins);
  const proactive = new ProactiveChatBehavior(() => botId, profiles, service, eligibility, ambient, logger);
  const registry = new BehaviorRegistry();
  registry.register(new MentionChatBehavior(() => botId, config, profiles, service, persona, logger, watches, null, eligibility, origins));
  registry.register(ambient); registry.register(proactive);
  const dispatcher = new BehaviorDispatcher(registry, logger);
  cleanups.push(async () => { service.stopScheduling(); await service.drain(); runtime.stop(); connection.close(); });
  const execute = async (): Promise<void> => {
    if (mode === "reaction") {
      await watches.register({ guildId, channelId, messageId: bot.id }, Date.now() - 2000);
      await watches.armOnFirstReaction(bot.id, Date.now() - 1000, 1000);
      const client = { user: { id: botId }, channels: { fetch: () => Promise.resolve(channel) } } as unknown as Client;
      await new ReactionReplyScheduler(client, watches, profiles, service, persona, logger, config, null, eligibility, origins).checkNow(Date.now());
    } else {
      await dispatcher.dispatch(BehaviorEvent.MessageCreated, source);
      await vi.advanceTimersByTimeAsync(16000); await service.drain();
    }
  };
  return { execute, records, decision, reply, sent, reacted, source, origins, state, fetch, profiles };
}

describe("production Discord adapter to effect paths", () => {
  it.each(["mention", "reply", "ping", "name"] as const)("history opt-out still permits the authorized current %s", async (mode) => {
    const fixture = await setup("legacy_context", mode, "reply", 1, false); await fixture.execute();
    expect(fixture.reply).toHaveBeenCalledOnce();
    expect(fixture.reply.mock.calls[0]![0].channelHistory).toEqual([]);
    expect(fixture.reply.mock.calls[0]![0].replyChain).toEqual([]);
    expect(fixture.sent).toHaveLength(1);
  });

  it("does not confuse the bounded reactor-name projection with the full authorized audience", async () => {
    const fixture = await setup("legacy_context", "reaction", "reply", 21); await fixture.execute();
    expect(fixture.reply).toHaveBeenCalledOnce(); expect(fixture.reply.mock.calls[0]![0].mentionedUsers).toHaveLength(21);
    expect(fixture.sent).toHaveLength(1); expect(fixture.sent[0]?.target).toBe("answer");
  });
  for (const strategy of ["legacy_context", "guarded_legacy_decision", "contextual"] as const) {
    it.each(["mention", "reply", "ping", "name", "followup", "group", "reaction"] as const)(`${strategy}: %s reaches its planned lifecycle`, async (mode) => {
      const fixture = await setup(strategy, mode); await fixture.execute();
      expect(fixture.reply).toHaveBeenCalledOnce();
      const optional = mode === "followup" || mode === "group" || mode === "reaction";
      expect(fixture.decision).toHaveBeenCalledTimes(optional ? 1 : 0);
      expect(fixture.sent).toHaveLength(1); expect(fixture.sent[0]?.target).toBe(mode === "reaction" ? "answer" : "current");
      expect(fixture.records.filter((record) => record.event === "chat.turn.completed")).toHaveLength(1);
      expect(fixture.records).toContainEqual(expect.objectContaining({ event: "chat.turn.plan", context: "guarded_text", state: "ready" }));
      const stored = await fixture.origins.find(guildId, channelId, "delivered-1");
      expect(stored?.origin).toBe("chat");
      expect(stored?.contextProvenance?.coverage).toBe("complete");
    });
  }
  it.each(["followup", "reaction"] as const)("%s carries an approved emoji through the actual callback", async (mode) => {
    const fixture = await setup("contextual", mode, "react"); await fixture.execute();
    expect(fixture.decision).toHaveBeenCalledOnce(); expect(fixture.reply).not.toHaveBeenCalled();
    expect(fixture.sent).toEqual([]); expect(fixture.reacted).toEqual([`${fixture.source.id}:👍`]);
  });
  it.each(["failed", "invalid_generation", "revoked", "shadow"] as const)("cannot bypass authorization/effect ownership on %s", async (behavior) => {
    const fixture = await setup("contextual", "followup", behavior); await fixture.execute();
    expect(fixture.decision).toHaveBeenCalledOnce();
    expect(fixture.sent).toEqual([]); expect(fixture.reacted).toEqual([]);
    expect(fixture.reply).toHaveBeenCalledTimes(behavior === "failed" ? 0 : 1);
    expect(fixture.records.filter((record) => record.event === "chat.turn.completed")).toHaveLength(1);
  });
});
