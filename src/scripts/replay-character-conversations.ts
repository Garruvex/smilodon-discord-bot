import "dotenv/config";
import { replayParticipation } from "../application/chat/participation-evaluation.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pino from "pino";
import { loadConfiguration } from "../config/environment.js";
import { guildConfigurationFileSchema } from "../config/guild-configuration-schema.js";
import { applyGuildConfigurationUpdate, toGuildConfiguration } from "../config/guild-configuration-document.js";
import type { GuildConfigurationProvider } from "../config/guild-configuration-provider.js";
import type { GuildConfiguration } from "../config/guild-configuration.js";
import { createChatProviderFromConfig } from "../bootstrap/dependencies.js";
import { characterSettingsSchema } from "../application/chat/character-settings.js";
import { replayCharacterConversations, replayManifestSchema } from "../application/chat/character-evaluation.js";
import { CharacterRuntime } from "../application/chat/character-runtime.js";
import { ChatConversationService } from "../application/chat/chat-conversation-service.js";
import { createGuardedMemoryEngine } from "../application/context/guarded-memory-gateway.js";
import { createSqliteDatabaseConnection } from "../infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../infrastructure/persistence/sqlite-memory-repository.js";
import { SqliteChatStateStore } from "../infrastructure/persistence/sqlite-chat-state-store.js";
import { syntheticReplaySource, syntheticReplayConfiguration } from "../application/chat/synthetic-replay-context.js";
import type { GuardedContextSource } from "../application/chat/guarded-conversation-context.js";
import { resolveChannelMemoryMode } from "../application/memory/memory-channel-policy.js";

const args = process.argv.slice(2);
const argument = (name: string): string | null => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? null : null; };
if (args.includes("--help")) {
  process.stdout.write("Usage: npm run eval:character-replay -- --fixture replay.json --persona personality.md [--settings character-settings.json] [--output review.json]\nFor deterministic policy comparison: --participation-fixture tests/fixtures/participation-replay.json [--output review.json] (no network calls or Discord sends).\nRequires a consented, anonymized manifest with pseudonymous numeric Discord IDs. Uses configured providers and a new temporary database; posts nothing to Discord.\n");
} else if (argument("--participation-fixture")) {
  const fixture = JSON.parse(await readFile(resolve(argument("--participation-fixture")!), "utf8")) as unknown;
  const outputs = await replayParticipation(fixture);
  const path = resolve(argument("--output") ?? "participation-replay-review.json");
  await writeFile(path, JSON.stringify({ synthetic: true, mode: "recorded-policy-comparison", scope: "Legacy deterministic policy helper with supplied proposals; not current contextual-flow acceptance.", hypotheticalOnly: true, humanReviewRequired: true, outputs }, null, 2), "utf8");
  process.stdout.write(`Participation replay: ${outputs.filter((row) => row.correct).length}/${outputs.length} labelled cases match. Review: ${path}\n`);
  if (outputs.some((row) => !row.correct)) process.exitCode = 1;
} else {
  const fixturePath = argument("--fixture"); const personaPath = argument("--persona");
  if (!fixturePath || !personaPath) throw new Error("--fixture and --persona are required; use --help for usage.");
  const manifest = replayManifestSchema.parse(JSON.parse(await readFile(resolve(fixturePath), "utf8")) as unknown);
  if (manifest.turns.some((turn) => !/^\d{17,20}$/u.test(turn.speakerId) || !/^\d{17,20}$/u.test(turn.channelId))) throw new Error("Use pseudonymous numeric Discord IDs (17–20 digits), not real member identifiers.");
  const configuration = loadConfiguration(); if (!configuration.chat) throw new Error("Configure CHATBOT_MODEL before running a replay.");
  const logger = pino({ level: "warn" }); const provider = createChatProviderFromConfig(configuration.chat, logger);
  const utility = configuration.utilityChat ? createChatProviderFromConfig(configuration.utilityChat, logger) : provider;
  const personality = await readFile(resolve(personaPath), "utf8");
  const settingsPath = argument("--settings"); const settings = settingsPath ? characterSettingsSchema.parse(JSON.parse(await readFile(resolve(settingsPath), "utf8")) as unknown) : characterSettingsSchema.parse({});
  const guildId = "100000000000000001";
  const botId = "1000000000000000200";
  const persona = await syntheticReplayConfiguration(guildId, personality, async () => await readFile(resolve(personaPath), "utf8") === personality);
  const sources = new Map<string, GuardedContextSource>();
  let document = guildConfigurationFileSchema.parse({ schemaVersion: 1, guild: { id: guildId, name: "Anonymized replay" },
    features: { chatbot: true, channelHistory: true }, chat: { sharedMemoryEnabled: true }, character: settings });
  const current = (): GuildConfiguration => toGuildConfiguration(document, "replay");
  const profiles: GuildConfigurationProvider = { initialize: () => Promise.resolve(), find: (id) => id === guildId ? current() : null,
    require: (id) => { if (id !== guildId) throw new Error("Unknown replay guild"); return current(); }, getAll: () => [current()],
    create: () => Promise.reject(new Error("Replay guild is fixed")), update: (_id, input) => { document = applyGuildConfigurationUpdate(document, input); return Promise.resolve(current()); }, reload: () => Promise.resolve() };
  let now = manifest.turns[0]!.timestampMs; const clock = (): number => now;
  const directory = await mkdtemp(join(tmpdir(), "character-replay-")); const connection = createSqliteDatabaseConnection(directory);
  const repository = new SqliteMemoryRepository(connection.database);
  const memoryEngine = createGuardedMemoryEngine(repository, null, logger, undefined, utility, null, (id) => Promise.resolve(id === botId), () => true, () => null, clock);
  const runtime = new CharacterRuntime(profiles, repository, utility.generateCharacterData ? { generateCharacterData: utility.generateCharacterData.bind(utility) } : null, provider, undefined, null, clock);
  const conversation = new ChatConversationService(provider, new SqliteChatStateStore(connection.database), memoryEngine,
    undefined, undefined, undefined, null, null, null, logger, utility, null, null, null, runtime, clock);
  try {
    const output = await replayCharacterConversations(manifest, async (turn) => {
      now = turn.timestampMs;
      const event = { messageId: `replay-${sources.size}-${now}-${turn.speakerId}`, timestampMs: now, authorId: turn.speakerId, authorDisplayName: `Member-${turn.speakerId.slice(-4)}`,
        content: turn.message, imageCount: 0, channelId: turn.channelId,
        author: { id: turn.speakerId, displayName: `Member-${turn.speakerId.slice(-4)}`, roleNames: [], kind: "human" as const } };
      sources.set(event.messageId, { event, origin: "human", provenance: null });
      const port = syntheticReplaySource({ guildId, channelId: turn.channelId, sourceMessageId: event.messageId, actorId: turn.speakerId }, sources,
        resolveChannelMemoryMode(current().chat.channelMemoryModes, turn.channelId));
      conversation.observe(guildId, turn.channelId, event);
      const response = await conversation.run({ guildId, channelId: turn.channelId, sourceMessageId: event.messageId,
        channelHistoryEnabled: true, guardedContextPort: port, configurationContext: persona, personality, personaDrift: null, examplePool: [], loreChunks: [],
        currentUser: { id: turn.speakerId, displayName: event.authorDisplayName, roleNames: [] }, mentionedUsers: [],
        message: turn.message, replyChain: [], channelHistory: [], images: [], webSearchMode: "off", imageGenerationEnabled: false, includeSources: false,
        interaction: "direct_mention", botUserId: botId, currentEvent: { type: "message", messageId: event.messageId, timestampMs: now, channelId: turn.channelId,
          authorId: turn.speakerId, mentionedUserIds: [], replyToMessageId: null }, channelMemoryModes: current().chat.channelMemoryModes }, (reply) => {
          reply.characterDeliveryProof = [{ messageId: `bot-${event.messageId}`, content: reply.text }];
          const delivered = { messageId: `bot-${event.messageId}`, channelId: turn.channelId, timestampMs: now + 0.5, authorId: botId, authorDisplayName: "Character",
            content: reply.text, imageCount: 0, replyToMessageId: event.messageId, replyToAuthorId: turn.speakerId, author: { id: botId, kind: "bot" as const, displayName: "Character", roleNames: [] } };
          sources.set(delivered.messageId, { event: delivered, origin: "chat", sourceMessageId: event.messageId, provenance: reply.contextProvenance ?? null });
          conversation.observe(guildId, turn.channelId, delivered);
          return Promise.resolve(reply.text);
        });
      await conversation.drain();
      return { timestampMs: now, speakerId: turn.speakerId, channelId: turn.channelId, expected: turn.expected,
        text: response.text, action: response.ambientAction, replyTargetMessageId: response.replyTargetMessageId ?? null };
    });
    const path = resolve(argument("--output") ?? "character-replay-review.json");
    await writeFile(path, JSON.stringify({ consented: true, anonymized: true, scope: "Common guarded conversation service with explicit synthetic source/configuration authority, real generated-reply provenance and a temporary database; excludes Discord effects.", evaluation: "human review required", outputs: output }, null, 2), "utf8");
    process.stdout.write(`Replay completed: ${output.length} turns. Review artifact: ${path}\nTemporary replay database: ${directory}\n`);
  } finally { conversation.stopScheduling(); await conversation.drain(); connection.close(); }
}
