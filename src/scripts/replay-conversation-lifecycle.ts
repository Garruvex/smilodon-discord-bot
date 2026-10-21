import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import pino from "pino";
import { ChatConversationService } from "../application/chat/chat-conversation-service.js";
import { CharacterRuntime } from "../application/chat/character-runtime.js";
import { contextualDecisionProviders } from "../application/chat/contextual-decision-providers.js";
import { contextualReplayCases } from "../application/chat/contextual-replay.js";
import { syntheticReplayContext, syntheticReplayConfiguration } from "../application/chat/synthetic-replay-context.js";
import type { ChatProvider, ChatResponse, ChatUser, StructuredCharacterProvider } from "../application/chat/chat-provider.js";
import type { ConversationInteraction } from "../application/chat/conversation-trigger.js";
import { conversationEffects } from "../application/chat/conversation-effects.js";
import { createGuardedMemoryEngine } from "../application/context/guarded-memory-gateway.js";
import { safeFailure } from "../application/diagnostics/chat-diagnostics.js";
import { loadInstanceEnvironment } from "../config/instance-environment.js";
import { loadConfiguration } from "../config/environment.js";
import { guildConfigurationFileSchema } from "../config/guild-configuration-schema.js";
import { createGuildConfigurationDocument, toGuildConfiguration } from "../config/guild-configuration-document.js";
import type { GuildConfigurationProvider } from "../config/guild-configuration-provider.js";
import { createChatProviderFromConfig } from "../bootstrap/dependencies.js";
import { HttpDecisionProvider } from "../infrastructure/chat/http-decision-provider.js";
import { guardModelTransport } from "../application/context/guarded-model-transport.js";
import { createSqliteDatabaseConnection } from "../infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../infrastructure/persistence/sqlite-memory-repository.js";
import { SqliteChatStateStore } from "../infrastructure/persistence/sqlite-chat-state-store.js";

const modes: readonly ConversationInteraction[] = ["direct_mention", "explicit_reply", "bare_ping", "name_address", "implicit_followup", "group_conversation", "reaction"];
const args = process.argv.slice(2);
const argument = (name: string): string | undefined => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
interface Result { language: string; mode: ConversationInteraction; passed: boolean; durationMs: number; action: string | null; reason: string | null;
  decisionCalls: number; generationCalls: number; verificationCalls: number; simulatedTextDeliveries: number; replyChars: number; generationTokens: number | null; failure?: ReturnType<typeof safeFailure> }
async function main(): Promise<void> {
  if (args.includes("--help")) { process.stdout.write("Usage: npm run eval:conversation -- [--live --instance pinecone] [--output report.json]\n21 synthetic application-service turns: seven modes and three languages. Real configured decision/reply providers in live mode; simulated source access and delivery, zero Discord sends. No production settings change.\n"); return; }
  const live = args.includes("--live"); const instance = argument("--instance");
  if (live && !instance) throw new Error("An explicit instance is required");
  const output = resolve(argument("--output") ?? "conversation-lifecycle-replay.json");
  const inventory = (["zh-TW", "en", "ja"] as const).flatMap((language) => modes.map((mode) => ({ language, mode })));
  if (!live) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify({ mode: "fixture_inventory_only", cases: inventory, discordSends: 0 }, null, 2)); return;
  }
  const configuration = loadConfiguration(loadInstanceEnvironment(instance!).environment); const logger = pino({ level: "silent" });
  if (!configuration.chat) throw new Error("No configured reply provider");
  const replyProvider = createChatProviderFromConfig(configuration.chat, logger);
  const utility = configuration.utilityChat ? createChatProviderFromConfig(configuration.utilityChat, logger) : replyProvider;
  const dedicated = configuration.decision ? guardModelTransport(new HttpDecisionProvider(configuration.decision)) : null;
  const results: Result[] = [];
  for (const { language, mode } of inventory) {
    const started = Date.now(); let decisionCalls = 0; let generationCalls = 0; let verificationCalls = 0; let generationTokens = 0; let measuredGenerations = 0; let deliveries = 0; let response: ChatResponse | null = null;
    const guildId = "100000000000000000"; const channelId = "100000000000000099";
    const fixture = structuredClone(contextualReplayCases().find((item) => item.language === language && item.scenario === (mode === "group_conversation" ? "group" : "answer") && item.id.endsWith("-960000-same"))!);
    const offset = started - fixture.current.timestampMs;
    fixture.events.forEach((event) => { event.timestampMs += offset; }); fixture.current.timestampMs = started;
    const requested = language === "zh-TW" ? "請說明第二個測試方案要怎麼測。" : language === "ja" ? "二番目のテスト方法を説明してください。" : "Please explain how to test the second option.";
    if (mode === "bare_ping") {
      fixture.events.push({ ...fixture.current, messageId: "1000000000000000005", timestampMs: started - 1, content: requested });
      fixture.current.content = "<@1000000000000000200>";
    } else if (mode === "name_address") fixture.current.content = `Pinecone, ${requested}`;
    else if (mode === "direct_mention") fixture.current.content = `<@1000000000000000200> ${requested}`;
    else if (mode === "explicit_reply") { fixture.current.replyToMessageId = fixture.events[1]!.messageId; fixture.current.replyToAuthorId = fixture.events[1]!.authorId; }
    const { port, sources, botId } = await syntheticReplayContext(fixture, guildId, channelId);
    const human: ChatUser = { id: fixture.current.authorId, displayName: "Alice", roleNames: [], kind: "human" };
    port.actor = (id): Promise<ChatUser | null> => Promise.resolve(id === human.id ? human : null);
    sources.set("denied-source", { event: { ...fixture.current, messageId: "denied-source", channelId, timestampMs: started - 2, content: "PRIVATE_REPLAY_SENTINEL" }, origin: "human", provenance: null });
    const read = port.read; port.read = (id, signal): ReturnType<typeof read> => id === "denied-source" ? Promise.resolve(null) : read(id, signal);
    const sourceId = mode === "reaction" ? fixture.events[1]!.messageId : fixture.current.messageId;
    if (mode === "reaction") { port.sourceMessageId = sourceId; port.actorId = null; }
    const document = createGuildConfigurationDocument({ guildId, guildName: "Synthetic lifecycle", displayName: "Pinecone", embedColor: "#3B82F6", idleImageUrl: null,
      botAdministratorRoleIds: [guildId], musicControllerRoleIds: [guildId], restrictedRoleIds: [], controlPanelChannelId: channelId });
    Object.assign(document.features, { chatbot: true, channelHistory: true, ambientReplies: true, reactionReplies: true, historyReactions: true });
    document.language = language; document.channels.chatbot = [channelId];
    document.character.context.enabled = true; document.character.context.retrievalMode = "eligible_count";
    Object.assign(document.chat.participation, { flowVersion: "contextual_v1", continuationEnabled: true, spontaneousEnabled: true, spontaneousChannelIds: [channelId] });
    const profile = toGuildConfiguration(guildConfigurationFileSchema.parse(document), "synthetic-replay");
    const profiles = { find: () => profile, require: () => profile, getAll: () => [profile] } as unknown as GuildConfigurationProvider;
    const structured = (provider: StructuredCharacterProvider | null): StructuredCharacterProvider | null => provider ? { generateCharacterData: (prompt, schema, options): Promise<unknown> => {
      if (prompt.includes("PRIVATE_REPLAY_SENTINEL")) throw new Error("Private source reached decision input"); decisionCalls++;
      return provider.generateCharacterData(prompt, schema, options);
    } } : null;
    const structuredReply = replyProvider.generateCharacterData ? { generateCharacterData: replyProvider.generateCharacterData.bind(replyProvider) } : null;
    const structuredUtility = utility.generateCharacterData ? { generateCharacterData: utility.generateCharacterData.bind(utility) } : null;
    const selected = contextualDecisionProviders(structured(dedicated), structured(structuredReply), structured(structuredUtility));
    const provider: ChatProvider = { reply: (request, observer): Promise<ChatResponse> => {
      const context = JSON.stringify([request.message, request.channelHistory, request.replyChain, request.characterContext, request.memories, request.recentHistory]);
      if (context.includes("PRIVATE_REPLAY_SENTINEL")) throw new Error("Private source reached generation input"); generationCalls++;
      return replyProvider.reply(request, observer).then((result) => { if (result.usage) { generationTokens += result.usage.totalTokens; measuredGenerations++; } return result; });
    } };
    const directory = await mkdtemp(join(tmpdir(), "conversation-lifecycle-")); const connection = createSqliteDatabaseConnection(directory);
    const repository = new SqliteMemoryRepository(connection.database);
    const utilityFacade: ChatProvider = { reply: utility.reply.bind(utility) };
    if (utility.verifyAttribution) utilityFacade.verifyAttribution = (...values: Parameters<NonNullable<ChatProvider["verifyAttribution"]>>): ReturnType<NonNullable<ChatProvider["verifyAttribution"]>> => {
      if (JSON.stringify(values.slice(0, 3)).includes("PRIVATE_REPLAY_SENTINEL")) throw new Error("Private source reached verification input");
      verificationCalls++; return utility.verifyAttribution!(...values);
    };
    const runtime = new CharacterRuntime(profiles, repository, null, provider, null, null, Date.now, logger, selected);
    const service = new ChatConversationService(provider, new SqliteChatStateStore(connection.database), createGuardedMemoryEngine(repository, null, null, undefined, null, null, null, () => true),
      undefined, undefined, undefined, null, null, null, logger, utilityFacade, null, null, null, runtime);
    const persona = await syntheticReplayConfiguration(guildId,
      `A fictional Discord bot named Pinecone. Reply in ${language}. Be concise. Do not claim an unverified repair or personal gameplay experience.`);
    try {
      response = await service.run({ guildId, channelId, sourceMessageId: sourceId, channelHistoryEnabled: true, guardedContextPort: port,
        personality: persona.material.text, configurationContext: persona,
        loreChunks: [], examplePool: [], personaDrift: null, currentUser: mode === "reaction" ? { id: botId, displayName: "Pinecone", roleNames: [], kind: "bot" } : human,
        mentionedUsers: [], message: fixture.current.content, replyChain: [], channelHistory: [], images: [], webSearchMode: "off", imageGenerationEnabled: false, includeSources: false,
        toolsEnabled: false, historyReactionsEnabled: true, botUserId: botId, interactionMode: mode,
        triggerMode: mode === "name_address" ? "ambient" : mode === "implicit_followup" ? "continuation" : mode === "group_conversation" ? "spontaneous" : mode === "reaction" ? "reaction" : "direct",
        currentEvent: mode === "reaction" ? { type: "reaction_snapshot", channelId, targetMessageId: sourceId, targetAuthorId: botId, observedAt: started, complete: true,
          exactReactionTimes: "unknown", reactions: [{ emoji: "👍", emojiId: null, actorIds: [human.id] }] } : { type: "message", messageId: sourceId, channelId,
          timestampMs: started, authorId: human.id, replyToMessageId: fixture.current.replyToMessageId ?? null, mentionedUserIds: [] },
      }, (result) => {
        deliveries++; result.characterDeliveryProof = [{ messageId: `simulated-${sourceId}`, content: result.text }]; return Promise.resolve(result.text);
      });
      const effects = conversationEffects(response); const decision = response.conversationDecision;
      const required = mode !== "group_conversation" && mode !== "reaction";
      const passed = decision?.status === "ready" && effects !== null && (effects.action === "silent" || effects.targetMessageId === sourceId) &&
        (!required || deliveries === 1 && (decision.decision.intent === "answer" || decision.decision.intent === "clarify")) &&
        (required ? generationCalls >= 1 && generationCalls <= 2 : generationCalls <= 2) && (mode === "implicit_followup" || mode === "group_conversation" || mode === "reaction" ? decisionCalls >= 1 : decisionCalls === 0);
      results.push({ language, mode, passed, durationMs: Date.now() - started, action: effects?.action ?? null, reason: decision?.decision.reasonCode ?? null,
        decisionCalls, generationCalls, verificationCalls, simulatedTextDeliveries: deliveries, replyChars: response.text.length, generationTokens: measuredGenerations ? generationTokens : null });
    } catch (error) { results.push({ language, mode, passed: false, durationMs: Date.now() - started, action: null, reason: null, decisionCalls, generationCalls, verificationCalls,
      simulatedTextDeliveries: deliveries, replyChars: 0, generationTokens: null, failure: safeFailure(error, "operation_error") }); }
    finally { service.stopScheduling(); await service.drain(); runtime.stop(); connection.close(); }
    process.stdout.write(JSON.stringify({ language, mode, passed: results.at(-1)!.passed }) + "\n");
  }
  const durations = results.map((item) => item.durationMs).sort((a, b) => a - b);
  const summary = { mode: "live_synthetic_application_lifecycle", fixtureRevision: 2, verificationEnabled: !!utility.verifyAttribution, instance, cases: results.length, passed: results.filter((item) => item.passed).length,
    p50Ms: durations[Math.floor(durations.length * 0.5)], p95Ms: durations[Math.floor(durations.length * 0.95)],
    scope: "Real application service/runtime/context/decision/generation/attribution-verification/persistence. Simulated source authorization and delivery. Excludes Discord adapters, coalescing, and actual transport; adapter contracts are verified separately.",
    discordSends: 0, humanWordingReview: "Still required; content-free metadata checks do not establish tone or factual quality." };
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify({ summary, results }, null, 2));
  process.stdout.write(JSON.stringify({ ...summary, output }) + "\n"); if (summary.passed !== summary.cases) process.exitCode = 2;
}
void main().catch((error: unknown) => { process.stderr.write(JSON.stringify({ status: "failed", ...safeFailure(error, "operation_error") }) + "\n"); process.exitCode = 1; });
