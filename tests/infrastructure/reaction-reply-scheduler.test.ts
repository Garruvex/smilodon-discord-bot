import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ReactionReplyScheduler } from "../../src/infrastructure/discord/behaviors/reaction-reply-scheduler.js";
import { ChatConversationService } from "../../src/application/chat/chat-conversation-service.js";
import { DefaultMemoryEngine } from "../../src/application/memory/memory-engine.js";
import { SqliteMemoryRepository } from "../../src/infrastructure/persistence/sqlite-memory-repository.js";
import { createSqliteDatabaseConnection } from "../../src/infrastructure/database/sqlite-database.js";
import type { ChatProvider, ChatResponse } from "../../src/application/chat/chat-provider.js";
import type { ChatStateStore } from "../../src/application/chat/chat-state-store.js";
import type { MessageReactionWatch, MessageReactionWatchStore } from "../../src/application/chat/message-reaction-watch.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { PersonaSource } from "../../src/application/chat/persona-source.js";

const guildId = "guild-1";
const channelId = "channel-1";
const botId = "bot-1";
const messageId = "msg-1";

function profile(overrides: { reactionReplies?: boolean; chatbot?: boolean } = {}): GuildConfiguration {
  return {
    schemaVersion: 1,
    guildId, guildName: "Test Guild", displayName: "Yohta",
    embedColor: "#3B82F6", idleImageUrl: null, idleImageAsset: null,
    panel: { progressBar: { style: "standard", length: 12, customTheme: null } },
    features: {
      common: true, diagnostics: true, music: false, chatbot: overrides.chatbot ?? true, birthdays: false,
      reminders: false, nsfw: false, linkFix: false, retainMemberDataOnLeave: true, ambientReplies: false,
      channelHistory: false, reactionReplies: overrides.reactionReplies ?? true, historyReactions: false,
    },
    roles: { botAdministrator: new Set(), musicController: new Set(), restricted: new Set(), chatbot: new Set() },
    channels: {
      musicCommands: new Set(), controlPanel: null, auditLog: null, chatbot: new Set([channelId]),
      birthdayAnnouncements: null, joinAnnouncements: null, leaveAnnouncements: null, linkFix: new Set(),
    },
    timezone: "UTC",
    linkFixPlatforms: { twitter: true, threads: true, tiktok: true, instagram: true, reddit: true, bilibili: true },
    music: {
      defaultVolume: 75, maximumVolume: 150, volumeButtonStep: 10,
      emptyQueueAction: "disconnect", emptyQueueDelayMs: 120_000,
      emptyChannelAction: "pause", emptyChannelGracePeriodMs: 30_000, resumeWhenOccupied: true,
      djModeEnabled: false, openQueueRequestsEnabled: false,
    },
    chat: {
      personalityFile: null, personalityAsset: null, examplesFile: null, examplesAsset: null, cooldownSeconds: 30,
      deniedMessage: "Premium required.", deniedLinkUrl: null, deniedLinkLabel: null,
      webSearchMode: "off", toolCallingEnabled: false, disabledTools: [], imageInputEnabled: false,
      imageGenerationEnabled: false, selfReferenceImageAsset: null,
      includeSources: false, maxImagesPerRequest: 2, ambientCooldownSeconds: 20,
      channelHistoryLimit: 8, channelMemoryModes: {}, personaDriftEnabled: false,
      contextScanChannelIds: [], contextDailyChannelIds: [], contextSeedDays: 7,
    },
    sourceFile: "test.yaml",
  };
}

function providerFor(configuredProfile: GuildConfiguration | null): GuildConfigurationProvider {
  return {
    find: () => configuredProfile,
    getAll: () => (configuredProfile ? [configuredProfile] : []),
  } as unknown as GuildConfigurationProvider;
}

function personaSource(): PersonaSource {
  return {
    resolve: () => Promise.resolve({
      personality: "Friendly", loreChunks: [], examplePool: [], personaDrift: null, personalitySourceHash: "hash",
    }),
  };
}

function response(text: string, ambient: ChatResponse["ambientAction"] = "reply", emoji: string | null = null): ChatResponse {
  return {
    text, userMemoryActions: [], guildKnowledgeCandidates: [], sources: [], usage: null, webSearchUsed: false,
    generatedImages: [], ambientAction: ambient, reactionEmoji: emoji, historyReactions: [],
  };
}

function testConversationService(reply: ChatProvider["reply"]): ChatConversationService {
  const directory = mkdtempSync(join(tmpdir(), "reaction-reply-scheduler-"));
  const connection = createSqliteDatabaseConnection(directory);
  const repository = new SqliteMemoryRepository(connection.database);
  const engine = new DefaultMemoryEngine(repository);
  const store: ChatStateStore = {
    initialize: () => Promise.resolve(),
    load: () => Promise.resolve({ exchanges: [], memories: [] }),
    commitSuccessfulExchange: () => Promise.resolve({ droppedExchanges: [] }),
    applyMemoryActions: () => Promise.resolve(),
    forgetMemory: () => Promise.resolve(false),
    forgetAllMemories: () => Promise.resolve(0),
    getDmNotesEnabled: () => Promise.resolve(true),
    setDmNotesEnabled: () => Promise.resolve(),
    purgeUser: () => Promise.resolve(),
  };
  const provider: ChatProvider = { reply };
  return new ChatConversationService(provider, store, engine);
}

function fakeWatchStore(
  due: readonly MessageReactionWatch[],
): { store: MessageReactionWatchStore; markDone: ReturnType<typeof vi.fn> } {
  const markDone = vi.fn(() => Promise.resolve());
  const store: MessageReactionWatchStore = {
    initialize: () => Promise.resolve(),
    register: () => Promise.resolve(),
    armOnFirstReaction: () => Promise.resolve(true),
    dequeueDue: () => Promise.resolve(due),
    markDone,
    deleteOlderThan: () => Promise.resolve(0),
  };
  return { store, markDone };
}

function watch(overrides: Partial<MessageReactionWatch> = {}): MessageReactionWatch {
  return { messageId, guildId, channelId, status: "pending", firstReactionAt: 0, dueAt: 1_000, ...overrides };
}

// Reactor ids -> a fake reaction with a .users.fetch() returning them.
function fakeMessage(reactorIds: readonly string[], overrides: { content?: string } = {}): unknown {
  const usersById = reactorIds.map((id) => ({ id, bot: false }));
  const sent = { id: "sent-1" };
  return {
    id: messageId,
    author: { id: botId, username: "Bot" },
    content: overrides.content ?? "hello!",
    channelId,
    member: null,
    guild: { members: { fetch: (id: string) => Promise.resolve({ displayName: id }) } },
    reactions: {
      cache: new Map([["😂", { users: { fetch: () => Promise.resolve(new Map(usersById.map((u) => [u.id, u]))) } }]]),
    },
    react: () => Promise.resolve(),
    reply: () => Promise.resolve(sent),
  };
}

function fakeClient(message: unknown): unknown {
  const channel = {
    isTextBased: (): boolean => true,
    isDMBased: (): boolean => false,
    guildId,
    nsfw: false,
    messages: { fetch: (): Promise<unknown> => Promise.resolve(message) },
    send: (): Promise<unknown> => Promise.resolve({ id: "sent-2" }),
  };
  return {
    user: { id: botId },
    channels: { fetch: (): Promise<unknown> => Promise.resolve(channel) },
  };
}

describe("ReactionReplyScheduler", () => {
  it("marks a watch done without ever calling the model when unique reactors stay below threshold", async () => {
    const reply = vi.fn(() => Promise.resolve(response("should not be sent")));
    const conversation = testConversationService(reply);
    const message = fakeMessage(["r1", "r2"]); // below the default threshold of 5
    const { store, markDone } = fakeWatchStore([watch()]);
    const scheduler = new ReactionReplyScheduler(
      fakeClient(message) as never, store, providerFor(profile()), conversation, personaSource(),
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
    );

    await scheduler.checkNow(2_000);

    expect(reply).not.toHaveBeenCalled();
    expect(markDone).toHaveBeenCalledWith(messageId, 2_000);
  });

  it("asks the model and delivers its reply once unique reactors meet the threshold", async () => {
    const reply = vi.fn(() => Promise.resolve(response("That got a reaction!", "reply")));
    const conversation = testConversationService(reply);
    const message = fakeMessage(["r1", "r2", "r3", "r4", "r5"]);
    const { store, markDone } = fakeWatchStore([watch()]);
    const scheduler = new ReactionReplyScheduler(
      fakeClient(message) as never, store, providerFor(profile()), conversation, personaSource(),
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
    );

    await scheduler.checkNow(2_000);

    expect(reply).toHaveBeenCalledOnce();
    expect(markDone).toHaveBeenCalledWith(messageId, 2_000);
  });

  it("skips evaluation entirely (and still marks done) when reactionReplies is off for the guild", async () => {
    const reply = vi.fn(() => Promise.resolve(response("should not be sent")));
    const conversation = testConversationService(reply);
    const message = fakeMessage(["r1", "r2", "r3", "r4", "r5"]);
    const { store, markDone } = fakeWatchStore([watch()]);
    const scheduler = new ReactionReplyScheduler(
      fakeClient(message) as never, store, providerFor(profile({ reactionReplies: false })), conversation, personaSource(),
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
    );

    await scheduler.checkNow(2_000);

    expect(reply).not.toHaveBeenCalled();
    expect(markDone).toHaveBeenCalledWith(messageId, 2_000);
  });

  it("marks a watch done when the message has been deleted", async () => {
    const reply = vi.fn(() => Promise.resolve(response("should not be sent")));
    const conversation = testConversationService(reply);
    const { store, markDone } = fakeWatchStore([watch()]);
    const scheduler = new ReactionReplyScheduler(
      fakeClient(null) as never, store, providerFor(profile()), conversation, personaSource(),
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never,
    );

    await scheduler.checkNow(2_000);

    expect(reply).not.toHaveBeenCalled();
    expect(markDone).toHaveBeenCalledWith(messageId, 2_000);
  });
});
