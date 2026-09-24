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
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { PersonaSource } from "../../src/application/chat/persona-source.js";
import { defaultMemoryEngineLimits } from "../../src/application/memory/memory-engine.js";

const guildId = "guild-1";
const channelId = "channel-1";

function configuration(): ApplicationConfiguration {
  return {
    environment: "test",
    logLevel: "fatal",
    discord: { token: "test-token", applicationId: "789012345678901234" },
    ownerUserIds: new Set(),
    guildConfigurationDirectory: "unused",
    runtimeDataDirectory: "unused",
    persistence: { driver: "file", databaseUrl: null },
    lavalink: { host: "localhost", port: 2333, password: "test-password", secure: false },
    chat: null,
    utilityChat: null,
    embeddings: null,
    memory: defaultMemoryEngineLimits,
    chatDelivery: { maxGeneratedImageAggregateBytes: 10 * 1024 * 1024 },
  };
}
const botId = "bot-1";
const messageId = "msg-1";
const chatbotRoleId = "chatbot-role";

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
    roles: { botAdministrator: new Set(), musicController: new Set(), restricted: new Set(), chatbot: new Set([chatbotRoleId]) },
    channels: {
      musicCommands: new Set(), controlPanel: null, auditLog: null, adminPanel: null, chatbot: new Set([channelId]),
      birthdayAnnouncements: null, joinAnnouncements: null, leaveAnnouncements: null, linkFix: new Set(),
    },
    timezone: "UTC",
    language: "en",
    linkFixPlatforms: { twitter: true, threads: true, tiktok: true, instagram: true, reddit: true, bilibili: true },
    music: {
      defaultVolume: 75, maximumVolume: 150, volumeButtonStep: 10,
      emptyQueueAction: "disconnect", emptyQueueDelayMs: 120_000,
      emptyChannelAction: "pause", emptyChannelGracePeriodMs: 30_000, resumeWhenOccupied: true,
      djModeEnabled: false, openQueueRequestsEnabled: false, autoQueueVoteEnabled: true, autoQueueVoteBarStyle: "squares", autoQueueVoteOptionCount: 3,
    },
    chat: {
      personalityFile: null, personalityAsset: null, examplesFile: null, examplesAsset: null, cooldownSeconds: 30,
      deniedMessage: "Premium required.", deniedLinkUrl: null, deniedLinkLabel: null,
      webSearchMode: "off", toolCallingEnabled: false, disabledTools: [], imageInputEnabled: false,
      imageGenerationEnabled: false, selfReferenceImageAsset: null,
      includeSources: false, maxImagesPerRequest: 2, ambientCooldownSeconds: 20,
      channelHistoryLimit: 8, reactionReplyWaitMinMinutes: 2, reactionReplyWaitMaxMinutes: 5, channelMemoryModes: {}, personaDriftEnabled: false,
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
// `noAccessIds` names reactors who lack the chatbot role (and so should be
// filtered out by ChatAccessService before they ever count toward the
// threshold). `reactionUsersFetch` lets a test override the per-emoji
// users.fetch() behavior (e.g. to reject, simulating a transient failure).
function fakeMessage(reactorIds: readonly string[], overrides: {
  content?: string;
  noAccessIds?: readonly string[];
  reactionUsersFetch?: () => Promise<Map<string, { id: string; bot: boolean }>>;
} = {}): unknown {
  const usersById = reactorIds.map((id) => ({ id, bot: false }));
  const noAccessIds = new Set(overrides.noAccessIds ?? []);
  const sent = { id: "sent-1" };
  return {
    id: messageId,
    author: { id: botId, username: "Bot" },
    content: overrides.content ?? "hello!",
    channelId,
    member: null,
    guild: {
      members: {
        fetch: (id: string) => Promise.resolve({
          displayName: id,
          roles: { cache: new Map(noAccessIds.has(id) ? [] : [[chatbotRoleId, {}]]) },
        }),
      },
    },
    reactions: {
      cache: new Map([["😂", {
        users: { fetch: overrides.reactionUsersFetch ?? ((): Promise<Map<string, { id: string; bot: boolean }>> => Promise.resolve(new Map(usersById.map((u) => [u.id, u])))) },
      }]]),
    },
    react: () => Promise.resolve(),
    reply: () => Promise.resolve(sent),
  };
}

function fakeClient(message: unknown, overrides: { messagesFetch?: () => Promise<unknown> } = {}): unknown {
  const channel = {
    isTextBased: (): boolean => true,
    isDMBased: (): boolean => false,
    guildId,
    nsfw: false,
    messages: { fetch: overrides.messagesFetch ?? ((): Promise<unknown> => Promise.resolve(message)) },
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
    const message = fakeMessage([]); // no human reactors left (e.g. all removed) — below the threshold of 1
    const { store, markDone } = fakeWatchStore([watch()]);
    const scheduler = new ReactionReplyScheduler(
      fakeClient(message) as never, store, providerFor(profile()), conversation, personaSource(),
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never, configuration(),
    );

    await scheduler.checkNow(2_000);

    expect(reply).not.toHaveBeenCalled();
    expect(markDone).toHaveBeenCalledWith(messageId, 2_000);
  });

  it("asks the model and delivers its reply once unique reactors meet the threshold", async () => {
    const reply = vi.fn(() => Promise.resolve(response("That got a reaction!", "reply")));
    const conversation = testConversationService(reply);
    const message = fakeMessage(["r1"]); // a single reactor meets the threshold
    const { store, markDone } = fakeWatchStore([watch()]);
    const scheduler = new ReactionReplyScheduler(
      fakeClient(message) as never, store, providerFor(profile()), conversation, personaSource(),
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never, configuration(),
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
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never, configuration(),
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
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never, configuration(),
    );

    await scheduler.checkNow(2_000);

    expect(reply).not.toHaveBeenCalled();
    expect(markDone).toHaveBeenCalledWith(messageId, 2_000);
  });

  it("excludes a reactor without chatbot access from the threshold count and from mentionedUsers", async () => {
    const reply = vi.fn(() => Promise.resolve(response("That got a reaction!", "reply")));
    const conversation = testConversationService(reply);
    // 2 raw reactors, but both lack the chatbot role — none are eligible,
    // below the threshold of 1.
    const message = fakeMessage(["r1", "r2"], { noAccessIds: ["r1", "r2"] });
    const { store, markDone } = fakeWatchStore([watch()]);
    const scheduler = new ReactionReplyScheduler(
      fakeClient(message) as never, store, providerFor(profile()), conversation, personaSource(),
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never, configuration(),
    );

    await scheduler.checkNow(2_000);

    expect(reply).not.toHaveBeenCalled();
    expect(markDone).toHaveBeenCalledWith(messageId, 2_000);
  });

  it("still asks the model once enough reactors remain eligible after excluding access-denied ones", async () => {
    const reply = vi.fn(() => Promise.resolve(response("That got a reaction!", "reply")));
    const conversation = testConversationService(reply);
    // 2 raw reactors, 1 lacks access — 1 remains, meeting the threshold.
    const message = fakeMessage(["r1", "r2"], { noAccessIds: ["r2"] });
    const { store, markDone } = fakeWatchStore([watch()]);
    const scheduler = new ReactionReplyScheduler(
      fakeClient(message) as never, store, providerFor(profile()), conversation, personaSource(),
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never, configuration(),
    );

    await scheduler.checkNow(2_000);

    expect(reply).toHaveBeenCalledOnce();
    expect(markDone).toHaveBeenCalledWith(messageId, 2_000);
  });

  it("gives up immediately (no retry) on a terminal Discord error like an unknown/deleted message", async () => {
    const reply = vi.fn(() => Promise.resolve(response("should not be sent")));
    const conversation = testConversationService(reply);
    const messagesFetch = vi.fn(() => Promise.reject(Object.assign(new Error("Unknown Message"), { code: 10008 })));
    const { store, markDone } = fakeWatchStore([watch()]);
    const scheduler = new ReactionReplyScheduler(
      fakeClient(null, { messagesFetch }) as never, store, providerFor(profile()), conversation, personaSource(),
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never, configuration(),
    );

    await scheduler.checkNow(2_000);

    expect(reply).not.toHaveBeenCalled();
    expect(markDone).toHaveBeenCalledWith(messageId, 2_000);
    expect(messagesFetch).toHaveBeenCalledOnce();
  });

  it("retries a transient message-fetch failure across ticks instead of burning the watch, then gives up after repeated failures", async () => {
    const reply = vi.fn(() => Promise.resolve(response("should not be sent")));
    const conversation = testConversationService(reply);
    const messagesFetch = vi.fn(() => Promise.reject(new Error("ECONNRESET")));
    const { store, markDone } = fakeWatchStore([watch()]);
    const scheduler = new ReactionReplyScheduler(
      fakeClient(null, { messagesFetch }) as never, store, providerFor(profile()), conversation, personaSource(),
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never, configuration(),
    );

    await scheduler.checkNow(1_000);
    expect(markDone).not.toHaveBeenCalled();
    await scheduler.checkNow(2_000);
    expect(markDone).not.toHaveBeenCalled();
    await scheduler.checkNow(3_000);

    expect(reply).not.toHaveBeenCalled();
    expect(markDone).toHaveBeenCalledWith(messageId, 3_000);
    expect(messagesFetch).toHaveBeenCalledTimes(3);
  });

  it("retries instead of evaluating an undercounted total when a per-emoji reactor fetch fails", async () => {
    const reply = vi.fn(() => Promise.resolve(response("should not be sent")));
    const conversation = testConversationService(reply);
    const message = fakeMessage(["r1", "r2", "r3", "r4", "r5"], {
      reactionUsersFetch: () => Promise.reject(new Error("rate limited")),
    });
    const { store, markDone } = fakeWatchStore([watch()]);
    const scheduler = new ReactionReplyScheduler(
      fakeClient(message) as never, store, providerFor(profile()), conversation, personaSource(),
      { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never, configuration(),
    );

    await scheduler.checkNow(2_000);

    expect(reply).not.toHaveBeenCalled();
    expect(markDone).not.toHaveBeenCalled();
  });
});
