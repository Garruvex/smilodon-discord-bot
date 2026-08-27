import type { GuildMember, Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { AmbientChatBehavior } from "../../src/infrastructure/discord/behaviors/ambient-chat-behavior.js";
import { defaultMemoryEngineLimits } from "../../src/application/memory/memory-engine.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { ChatConversationService } from "../../src/application/chat/chat-conversation-service.js";

const botId = "111111111111111111";
const ownerId = "678901234567890123";
const chatbotRoleId = "234567890123456789";
const chatChannelId = "567890123456789012";
const otherChannelId = "222222222222222222";

function configuration(): ApplicationConfiguration {
  return {
    environment: "test",
    logLevel: "fatal",
    discord: { token: "test-token", applicationId: "789012345678901234" },
    ownerUserIds: new Set([ownerId]),
    guildConfigurationDirectory: "unused",
    runtimeDataDirectory: "unused",
    persistence: { driver: "file", databaseUrl: null },
    lavalink: { host: "localhost", port: 2333, password: "test-password", secure: false },
    chat: null,
    utilityChat: null,
    embeddings: null,
    memory: defaultMemoryEngineLimits,
  };
}

function profile(overrides: { ambientReplies?: boolean } = {}): GuildConfiguration {
  return {
    schemaVersion: 1,
    guildId: "123456789012345678",
    guildName: "Test Guild",
    displayName: "Yohta",
    embedColor: "#3B82F6",
    idleImageUrl: null,
    idleImageAsset: null,
    panel: { progressBar: { style: "standard", length: 12, customTheme: null } },
    features: {
      common: true, diagnostics: true, music: true, chatbot: true, birthdays: false, reminders: false,
      nsfw: false, linkFix: false, retainMemberDataOnLeave: true,
      ambientReplies: overrides.ambientReplies ?? true,
      channelHistory: false,
    },
    roles: {
      botAdministrator: new Set(),
      musicController: new Set(),
      restricted: new Set(),
      chatbot: new Set([chatbotRoleId]),
    },
    channels: {
      musicCommands: new Set(),
      controlPanel: null,
      auditLog: null,
      chatbot: new Set([chatChannelId]),
      birthdayAnnouncements: null,
      joinAnnouncements: null,
      leaveAnnouncements: null,
      linkFix: new Set(),
    },
    timezone: "UTC",
    linkFixPlatforms: {
      twitter: true, threads: true, tiktok: true, instagram: true, reddit: true, bilibili: true,
    },
    music: {
      defaultVolume: 75, maximumVolume: 150, volumeButtonStep: 10,
      emptyQueueAction: "disconnect", emptyQueueDelayMs: 120_000,
      emptyChannelAction: "pause", emptyChannelGracePeriodMs: 30_000, resumeWhenOccupied: true,
    },
    chat: {
      personalityFile: null, personalityAsset: null, examplesFile: null, examplesAsset: null, cooldownSeconds: 30,
      deniedMessage: "Premium required.", deniedLinkUrl: null, deniedLinkLabel: null,
      webSearchMode: "off", toolCallingEnabled: false, disabledTools: [], imageInputEnabled: false, imageGenerationEnabled: false,
      includeSources: true, maxImagesPerRequest: 2, ambientCooldownSeconds: 20,
      channelHistoryLimit: 8, channelMemoryModes: {}, personaDriftEnabled: false, contextScanChannelIds: [], contextDailyChannelIds: [], contextSeedDays: 7,
    },
    sourceFile: "test.yaml",
  };
}

function member(): GuildMember {
  return { roles: { cache: new Map([[chatbotRoleId, {}]]) } } as unknown as GuildMember;
}

function message(overrides: {
  content?: string;
  authorId?: string;
  bot?: boolean;
  mentionsBot?: boolean;
  channelId?: string;
} = {}): Message {
  return {
    inGuild: () => true,
    guildId: "123456789012345678",
    channelId: overrides.channelId ?? chatChannelId,
    content: overrides.content ?? "yohta is neat",
    author: { id: overrides.authorId ?? "890123456789012345", bot: overrides.bot ?? false },
    member: member(),
    mentions: { users: { has: (id: string) => (overrides.mentionsBot ?? false) && id === botId } },
    guild: { members: { me: { nickname: null, displayName: "Test Bot" } } },
  } as unknown as Message;
}

function provider(profileValue: GuildConfiguration | null): GuildConfigurationProvider {
  return { find: () => profileValue } as unknown as GuildConfigurationProvider;
}

function behavior(profileValue: GuildConfiguration | null, conversation: ChatConversationService | null = {} as ChatConversationService): AmbientChatBehavior {
  return new AmbientChatBehavior(
    () => botId,
    configuration(),
    provider(profileValue),
    conversation,
    { resolve: () => Promise.resolve({ personality: "Test persona", loreChunks: [], examplePool: [], personaDrift: null }) },
    { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
  );
}

describe("AmbientChatBehavior.matches", () => {
  it("matches a message naming the bot without an @mention", async () => {
    await expect(behavior(profile()).matches(message())).resolves.toBe(true);
  });

  it("defers to an explicit @mention instead of matching", async () => {
    await expect(behavior(profile()).matches(message({ mentionsBot: true }))).resolves.toBe(false);
  });

  it("does not match when ambientReplies is disabled", async () => {
    await expect(behavior(profile({ ambientReplies: false })).matches(message())).resolves.toBe(false);
  });

  it("does not match when the bot's name doesn't appear in the message", async () => {
    await expect(behavior(profile()).matches(message({ content: "good morning everyone" }))).resolves.toBe(false);
  });

  it("does not match outside configured chatbot channels", async () => {
    await expect(behavior(profile()).matches(message({ channelId: otherChannelId }))).resolves.toBe(false);
  });

  it("does not match without a conversation service configured", async () => {
    await expect(behavior(profile(), null).matches(message())).resolves.toBe(false);
  });

  it("does not match a bot author", async () => {
    await expect(behavior(profile()).matches(message({ bot: true }))).resolves.toBe(false);
  });
});
