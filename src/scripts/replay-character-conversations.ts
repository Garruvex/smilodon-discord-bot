import "dotenv/config";
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
import { DefaultMemoryEngine } from "../application/memory/memory-engine.js";
import { createSqliteDatabaseConnection } from "../infrastructure/database/sqlite-database.js";
import { SqliteMemoryRepository } from "../infrastructure/persistence/sqlite-memory-repository.js";
import { SqliteChatStateStore } from "../infrastructure/persistence/sqlite-chat-state-store.js";

const args = process.argv.slice(2);
const argument = (name: string): string | null => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? null : null; };
if (args.includes("--help")) {
  process.stdout.write("Usage: npm run eval:character-replay -- --fixture replay.json --persona personality.md [--settings character-settings.json] [--output review.json]\nRequires a consented, anonymized manifest with pseudonymous numeric Discord IDs. Uses configured providers and a new temporary database; posts nothing to Discord.\n");
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
  let document = guildConfigurationFileSchema.parse({ schemaVersion: 1, guild: { id: guildId, name: "Anonymized replay" },
    features: { chatbot: true, channelHistory: true }, chat: { sharedMemoryEnabled: true }, character: settings });
  const current = (): GuildConfiguration => toGuildConfiguration(document, "replay");
  const profiles: GuildConfigurationProvider = { initialize: () => Promise.resolve(), find: (id) => id === guildId ? current() : null,
    require: (id) => { if (id !== guildId) throw new Error("Unknown replay guild"); return current(); }, getAll: () => [current()],
    create: () => Promise.reject(new Error("Replay guild is fixed")), update: (_id, input) => { document = applyGuildConfigurationUpdate(document, input); return Promise.resolve(current()); }, reload: () => Promise.resolve() };
  let now = manifest.turns[0]!.timestampMs; const clock = (): number => now;
  const directory = await mkdtemp(join(tmpdir(), "character-replay-")); const connection = createSqliteDatabaseConnection(directory);
  const repository = new SqliteMemoryRepository(connection.database);
  const memoryEngine = new DefaultMemoryEngine(repository, null, logger, undefined, utility, null, (id) => Promise.resolve(id === "bot"), () => true, () => null, clock);
  const runtime = new CharacterRuntime(profiles, repository, utility.generateCharacterData ? { generateCharacterData: utility.generateCharacterData.bind(utility) } : null, provider, undefined, null, clock);
  const conversation = new ChatConversationService(provider, new SqliteChatStateStore(connection.database), memoryEngine,
    undefined, undefined, undefined, null, null, null, logger, utility, null, null, null, runtime, clock);
  try {
    const output = await replayCharacterConversations(manifest, async (turn) => {
      now = turn.timestampMs;
      const event = { messageId: `replay-${now}-${turn.speakerId}`, timestampMs: now, authorId: turn.speakerId, authorDisplayName: `Member-${turn.speakerId.slice(-4)}`,
        content: turn.message, imageCount: 0, channelId: turn.channelId };
      conversation.observe(guildId, turn.channelId, event);
      const response = await conversation.run({ guildId, channelId: turn.channelId, sourceMessageId: event.messageId,
        channelHistoryEnabled: true, personality, personaDrift: null, examplePool: [], loreChunks: [],
        currentUser: { id: turn.speakerId, displayName: event.authorDisplayName, roleNames: [] }, mentionedUsers: [],
        message: turn.message, replyChain: [], channelHistory: [], images: [], webSearchMode: "off", imageGenerationEnabled: false, includeSources: false,
        triggerMode: "direct", botUserId: "bot", currentEvent: { type: "message", messageId: event.messageId, timestampMs: now, channelId: turn.channelId,
          authorId: turn.speakerId, mentionedUserIds: [], replyToMessageId: null }, channelMemoryModes: current().chat.channelMemoryModes }, (reply) => {
          reply.characterDeliveryProof = [{ messageId: `bot-${event.messageId}`, content: reply.text }];
          conversation.observe(guildId, turn.channelId, { messageId: `bot-${event.messageId}`, timestampMs: now, authorId: "bot", authorDisplayName: "Character",
            content: reply.text, imageCount: 0, replyToMessageId: event.messageId, replyToAuthorId: turn.speakerId, author: { id: "bot", kind: "bot", displayName: "Character", roleNames: [] } });
          return Promise.resolve(reply.text);
        });
      await conversation.drain();
      return { timestampMs: now, speakerId: turn.speakerId, channelId: turn.channelId, expected: turn.expected,
        text: response.text, action: response.ambientAction, replyTargetMessageId: response.replyTargetMessageId ?? null };
    });
    const path = resolve(argument("--output") ?? "character-replay-review.json");
    await writeFile(path, JSON.stringify({ consented: true, anonymized: true, evaluation: "human review required", outputs: output }, null, 2), "utf8");
    process.stdout.write(`Replay completed: ${output.length} turns. Review artifact: ${path}\nTemporary replay database: ${directory}\n`);
  } finally { conversation.stopScheduling(); await conversation.drain(); connection.close(); }
}
