import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import type { Logger } from "pino";

import { CharacterRuntime } from "../application/chat/character-runtime.js";
import { characterSettingsSchema, type CharacterSettings } from "../application/chat/character-settings.js";
import { ChatConversationService, type ChatConversationInput } from "../application/chat/chat-conversation-service.js";
import type { ChannelHistoryMessage, ChatProvider, ChatRequest, ChatResponse } from "../application/chat/chat-provider.js";
import { contextualDecisionProviders } from "../application/chat/contextual-decision-providers.js";
import {
  continuityBotId, continuityCaseFileSchema, continuityFreezeHash, continuityVariantSettings, expandContinuityCase, type ContinuityCase, type ContinuityCaseFile, type ContinuityMessage, type ContinuityRow,
  type ContinuityVariant,
} from "../application/chat/continuity-evaluation.js";
import type { GuardedContextPort, GuardedContextReport, GuardedContextSource } from "../application/chat/guarded-conversation-context.js";
import { syntheticReplayConfiguration, syntheticReplaySource } from "../application/chat/synthetic-replay-context.js";
import { createGuardedMemoryEngine } from "../application/context/guarded-memory-gateway.js";
import { ProvenanceAdmissionGate, parseProvenanceReaderModes } from "../application/provenance/provenance-admission.js";
import { ProvenanceShadowWriter } from "../application/provenance/provenance-shadow.js";
import { applyGuildConfigurationUpdate, toGuildConfiguration } from "../config/guild-configuration-document.js";
import type { GuildConfigurationProvider } from "../config/guild-configuration-provider.js";
import { guildConfigurationFileSchema } from "../config/guild-configuration-schema.js";
import type { GuildConfiguration } from "../config/guild-configuration.js";
import { createSqliteDatabaseConnection } from "../infrastructure/database/sqlite-database.js";
import { SqliteChatStateStore } from "../infrastructure/persistence/sqlite-chat-state-store.js";
import { SqliteMemoryRepository } from "../infrastructure/persistence/sqlite-memory-repository.js";
import { SqliteProvenanceGraphStore } from "../infrastructure/persistence/sqlite-provenance-graph-store.js";

export const continuityGuildId = "100000000000000001";
export const continuityChannelId = "100000000000000002";

export interface ContinuityProviders {
  // Answers the evaluated final turn (and its decision for optional turns).
  reply: ChatProvider;
  utility: ChatProvider;
}
export interface ContinuityRunInput {
  file: ContinuityCaseFile; item: ContinuityCase; variant: ContinuityVariant; repeat: number;
  providers: ContinuityProviders; personality: string; settings?: Partial<CharacterSettings>; logger: Logger;
}

const silent = (text: string): ChatResponse => ({ text, ambientAction: "reply", reactionEmoji: null, historyReactions: [], userMemoryActions: [], guildKnowledgeCandidates: [],
  sources: [], usage: null, webSearchUsed: false, generatedImages: [] });

// Plays one case under one variant: every earlier bot answer goes through the same guarded
// conversation service as production (with a scripted provider returning the case's fixed text), so
// its proof, graph record and saved session exchange are real. Only the final turn uses the given
// providers. Nothing reaches Discord; the database is temporary.
export async function runContinuityCase(input: ContinuityRunInput): Promise<ContinuityRow & { request: ChatRequest | null; coverage: GuardedContextReport | null }> {
  const { file, item, variant, providers, logger } = input;
  const expanded = expandContinuityCase(file, item);
  const setting = continuityVariantSettings[variant];
  const directory = await mkdtemp(join(tmpdir(), "continuity-"));
  const connection = createSqliteDatabaseConnection(directory);
  const scripted: { text: string } = { text: "" };
  const seedProvider: ChatProvider = { reply: (): Promise<ChatResponse> => Promise.resolve(silent(scripted.text)) };
  let now = expanded.messages[0]?.timestampMs ?? expanded.final.timestampMs; const clock = (): number => now;
  const services: ChatConversationService[] = [];
  try {
    const repository = new SqliteMemoryRepository(connection.database);
    const state = new SqliteChatStateStore(connection.database); await state.initialize();
    const graph = new SqliteProvenanceGraphStore(connection.database);
    const gate = new ProvenanceAdmissionGate(graph, parseProvenanceReaderModes(setting.readers));
    const writer = new ProvenanceShadowWriter(graph);
    const settings = characterSettingsSchema.parse({ enabled: true, ...input.settings,
      context: { ...input.settings?.context, priorAnswerAnchor: setting.anchor } });
    let document = guildConfigurationFileSchema.parse({ schemaVersion: 1, guild: { id: continuityGuildId, name: "Continuity evaluation" },
      features: { chatbot: true, channelHistory: true, ambientReplies: true }, chat: { sharedMemoryEnabled: true }, character: settings });
    const current = (): GuildConfiguration => toGuildConfiguration(document, "continuity");
    const profiles: GuildConfigurationProvider = { initialize: () => Promise.resolve(), find: (id) => id === continuityGuildId ? current() : null,
      require: (id) => { if (id !== continuityGuildId) throw new Error("Unknown evaluation guild"); return current(); }, getAll: () => [current()],
      create: () => Promise.reject(new Error("Evaluation guild is fixed")), update: (_id, patch) => { document = applyGuildConfigurationUpdate(document, patch); return Promise.resolve(current()); },
      reload: () => Promise.resolve() };
    const persona = await syntheticReplayConfiguration(continuityGuildId, input.personality);
    const isBot = (id: string): Promise<boolean> => Promise.resolve(id === continuityBotId);
    const seedMemory = createGuardedMemoryEngine(repository, null, logger, undefined, seedProvider, null, isBot, () => true, () => null, clock);
    const seed = new ChatConversationService(seedProvider, state, seedMemory, undefined, undefined, undefined, null, null, null, logger, seedProvider, null, null, null, null, clock);
    const structured = (provider: ChatProvider): { generateCharacterData: NonNullable<ChatProvider["generateCharacterData"]> } | null =>
      provider.generateCharacterData ? { generateCharacterData: provider.generateCharacterData.bind(provider) } : null;
    const liveMemory = createGuardedMemoryEngine(repository, null, logger, undefined, providers.utility, null, isBot, () => true, () => null, clock);
    const runtime = new CharacterRuntime(profiles, repository, structured(providers.utility), providers.reply, structured(providers.utility), null, clock, logger,
      contextualDecisionProviders(null, structured(providers.reply), structured(providers.utility)));
    let request: ChatRequest | null = null;
    const capturing: ChatProvider = new Proxy(providers.reply, { get: (target, property, receiver): unknown => {
      if (property === "reply") return (next: ChatRequest, observer?: Parameters<ChatProvider["reply"]>[1]): Promise<ChatResponse> => { request = next; return target.reply(next, observer); };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
    const live = new ChatConversationService(capturing, state, liveMemory, undefined, undefined, undefined, null, null, null, logger, providers.utility, null, null, null, runtime, clock);
    services.push(seed, live);

    const sources = new Map<string, GuardedContextSource>();
    const eventOf = (message: ContinuityMessage): ChannelHistoryMessage => ({ messageId: message.messageId, channelId: continuityChannelId, timestampMs: message.timestampMs,
      authorId: message.authorId, authorDisplayName: message.bot ? "Character" : message.speaker, content: message.text, imageCount: 0,
      ...(message.replyTo ? { replyToMessageId: message.replyTo } : {}),
      author: { id: message.authorId, displayName: message.bot ? "Character" : message.speaker, roleNames: [], kind: message.bot ? "bot" : "human" } });
    let coverage: GuardedContextReport | null = null;
    const port = (sourceMessageId: string, actorId: string): GuardedContextPort => syntheticReplaySource({ guildId: continuityGuildId, channelId: continuityChannelId, sourceMessageId, actorId },
      sources, "shared", {
        // As in production with a citation policy: nobody here has forgotten anything or opted out.
        sourcesAllowed: (cited) => Promise.resolve(cited.map(() => true)),
        revoked: (ids) => Promise.resolve(ids.map(() => false)),
        graph: { mode: (kind) => gate.mode(kind),
          decide: (kind, candidates, audienceUserId) => gate.decideDetailed(kind, { guildId: continuityGuildId, channelId: continuityChannelId, audienceUserId }, candidates) },
        // The turn's own history read; later bookkeeping reads ask for no history.
        coverage: (report) => { if (sourceMessageId === expanded.final.messageId && report.requested > 0 && !coverage) coverage = report; },
      });
    const turn = (message: ContinuityMessage, interaction: ChatConversationInput["interaction"]): ChatConversationInput => ({
      guildId: continuityGuildId, channelId: continuityChannelId, sourceMessageId: message.messageId, channelHistoryEnabled: true,
      guardedContextPort: port(message.messageId, message.authorId), configurationContext: persona, personality: input.personality, personaDrift: null, examplePool: [], loreChunks: [],
      currentUser: { id: message.authorId, displayName: message.speaker, roleNames: [] }, mentionedUsers: [], message: message.text, replyChain: [], channelHistory: [], images: [],
      webSearchMode: "off", imageGenerationEnabled: false, includeSources: false, interaction, botUserId: continuityBotId,
      currentEvent: { type: "message", messageId: message.messageId, timestampMs: message.timestampMs, channelId: continuityChannelId, authorId: message.authorId,
        mentionedUserIds: [...message.text.matchAll(/<@!?(\d+)>/gu)].map((match) => match[1]!), replyToMessageId: null },
      channelMemoryModes: current().chat.channelMemoryModes,
    });
    // Records a delivered part the way chat delivery does: the origin with its proof, and the graph revision.
    const delivered = async (question: ContinuityMessage, reply: ChatResponse, messageId: string, at: number): Promise<string> => {
      reply.characterDeliveryProof = [{ messageId, content: reply.text }];
      const proof = reply.contextLease ? reply.contextLease.provenance(reply.text) : reply.contextProvenance ?? null;
      const event = eventOf({ lineId: null, messageId, speaker: "bot", authorId: continuityBotId, text: reply.text, bot: true, replyTo: question.messageId, timestampMs: at });
      sources.set(messageId, { event, origin: "chat", sourceMessageId: question.messageId, provenance: proof });
      if (proof && reply.contextLease) await writer.recordReplyPart({ messageId, guildId: continuityGuildId, channelId: continuityChannelId, origin: "chat",
        sourceMessageId: question.messageId, createdAt: at, contextProvenance: proof }, reply.contextLease.graphInputs());
      return reply.text;
    };

    for (const message of expanded.messages) {
      now = message.timestampMs;
      if (!message.bot) { sources.set(message.messageId, { event: eventOf(message), origin: "human", provenance: null }); seed.observe(continuityGuildId, continuityChannelId, eventOf(message)); continue; }
      const question = expanded.messages.find((candidate) => candidate.messageId === message.replyTo)!;
      scripted.text = message.text; now = message.timestampMs;
      await seed.run(turn(question, "direct_mention"), (reply) => delivered(question, reply, message.messageId, message.timestampMs));
      await seed.drain();
    }
    const final = expanded.final; now = final.timestampMs;
    sources.set(final.messageId, { event: eventOf(final), origin: "human", provenance: null });
    live.observe(continuityGuildId, continuityChannelId, eventOf(final));
    const started = performance.now(); let response: ChatResponse | null = null; let failure: string | null = null;
    try {
      response = await live.run(turn(final, final.interaction), (reply) => delivered(final, reply, `14${final.messageId.slice(2)}`, final.timestampMs + 500));
      await live.drain();
    } catch (error) { failure = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown"; }
    const latencyMs = performance.now() - started;
    const requiredId = item.labels.required ? expanded.lineMessageIds.get(item.labels.required.line)! : null;
    const requiredText = requiredId ? expanded.messages.find((candidate) => candidate.messageId === requiredId)!.text : null;
    const captured = request as ChatRequest | null;
    const seen = captured ? JSON.stringify({ history: captured.channelHistory, chain: captured.replyChain, recent: captured.recentHistory, burst: captured.currentBurst ?? [] }) : null;
    const text = response?.text ?? "";
    const report = coverage as GuardedContextReport | null;
    return {
      caseId: item.id, variant, repeat: input.repeat, language: item.language, scenario: item.scenario, interaction: final.interaction, expected: item.labels.action,
      action: text.trim() && response?.ambientAction !== "ignore" ? "reply" : "ignore", text, replyTargetMessageId: response?.replyTargetMessageId ?? null, targetMessageId: final.messageId,
      contextHasRequired: requiredText && seen !== null ? seen.includes(JSON.stringify(requiredText).slice(1, -1)) : null,
      anchorAdded: report?.anchor ?? 0, latencyMs, failure, request: captured, coverage: report,
    };
  } finally {
    for (const service of services) { service.stopScheduling(); await service.drain().catch(() => undefined); }
    connection.close();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

const casesPath = resolve("tests/fixtures/continuity/cases.json");
const freezePath = resolve("tests/fixtures/continuity/freeze.json");
export const continuityBaselinePath = resolve("tests/fixtures/continuity/offline-baseline.json");

export const scriptedReply: ChatProvider = { reply: (): Promise<ChatResponse> => Promise.resolve({ text: "ok", ambientAction: "reply", reactionEmoji: null, historyReactions: [],
  userMemoryActions: [], guildKnowledgeCandidates: [], sources: [], usage: null, webSearchUsed: false, generatedImages: [] }) };
export const offlinePersona = "You are a friendly regular in this Discord server. Reply briefly and casually.";

export async function loadFrozenCases(): Promise<ContinuityCaseFile> {
  const file = continuityCaseFileSchema.parse(JSON.parse(await readFile(casesPath, "utf8")) as unknown);
  const freeze = JSON.parse(await readFile(freezePath, "utf8")) as { sha256: string };
  if (continuityFreezeHash(file) !== freeze.sha256) throw new Error("The continuity cases no longer match their freeze hash. Freeze a new version instead of editing the frozen one.");
  return file;
}

// The offline baseline: whether each case's required statement reached the context, and what the anchor added.
export function offlineBaselineOf(rows: readonly ContinuityRow[]): Record<string, { contextHasRequired: boolean | null; anchorAdded: number }> {
  return Object.fromEntries(rows.map((row) => [`${row.caseId}/${row.variant}`, { contextHasRequired: row.contextHasRequired, anchorAdded: row.anchorAdded }]));
}

