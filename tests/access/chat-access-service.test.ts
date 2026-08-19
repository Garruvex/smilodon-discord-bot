import type { GuildMember } from "discord.js";
import { describe, expect, it } from "vitest";

import { ChatAccessService } from "../../src/application/access/chat-access-service.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";

const ownerId = "678901234567890123";
const chatbotRoleId = "234567890123456789";
const administratorRoleId = "345678901234567890";
const restrictedRoleId = "456789012345678901";
const chatChannelId = "567890123456789012";

function configuration(): ApplicationConfiguration {
  return {
    environment: "test",
    logLevel: "fatal",
    discord: {
      token: "test-token",
      applicationId: "789012345678901234",
    },
    ownerUserIds: new Set([ownerId]),
    guildConfigurationDirectory: "unused",
    runtimeDataDirectory: "unused",
    persistence: { driver: "file", databaseUrl: null },
    lavalink: {
      host: "localhost",
      port: 2333,
      password: "test-password",
      secure: false,
    },
    chat: null,
  };
}

function profile(): GuildConfiguration {
  return {
    schemaVersion: 1,
    guildId: "123456789012345678",
    guildName: "Test Guild",
    displayName: "Test Bot",
    embedColor: "#3B82F6",
    idleImageUrl: null,
    idleImageAsset: null,
    panel: {
      progressBar: { style: "standard", length: 12, customTheme: null },
    },
    features: {
      common: true,
      diagnostics: true,
      music: true,
      chatbot: true,
      birthdays: false,
      nsfw: false,
      linkFix: false,
      retainMemberDataOnLeave: true,
      ambientReplies: false,
      channelHistory: false,
    },
    roles: {
      botAdministrator: new Set([administratorRoleId]),
      musicController: new Set(),
      restricted: new Set([restrictedRoleId]),
      chatbot: new Set([chatbotRoleId]),
    },
    channels: {
      musicCommands: new Set(),
      controlPanel: null,
      auditLog: null,
      chatbot: new Set([chatChannelId]),
      birthdayAnnouncements: null,
      linkFix: new Set(),
    },
    music: {
      defaultVolume: 75,
      maximumVolume: 150,
      volumeButtonStep: 10,
      emptyQueueAction: "disconnect",
      emptyQueueDelayMs: 120_000,
      emptyChannelAction: "pause",
      emptyChannelGracePeriodMs: 30_000,
      resumeWhenOccupied: true,
    },
    chat: {
      personalityFile: null,
      personalityAsset: null,
      cooldownSeconds: 30,
      deniedMessage: "Premium required.",
      deniedLinkUrl: null,
      deniedLinkLabel: null,
      webSearchMode: "off", toolCallingEnabled: false,
      imageInputEnabled: false,
      imageGenerationEnabled: false,
      includeSources: true,
      maxImagesPerRequest: 2,
      ambientCooldownSeconds: 20,
      channelHistoryLimit: 8,
    },
    sourceFile: "test.yaml",
  };
}

function member(roleIds: readonly string[]): GuildMember {
  return {
    roles: { cache: new Map(roleIds.map((roleId) => [roleId, {}])) },
  } as unknown as GuildMember;
}

describe("ChatAccessService", () => {
  it("allows configured chatbot members in allowed channels", () => {
    const service = new ChatAccessService(configuration());

    expect(
      service.canUseMentionChat(profile(), member([chatbotRoleId]), "890123456789012345", chatChannelId),
    ).toBe(true);
  });

  it("denies restricted members unless they are bot owners", () => {
    const service = new ChatAccessService(configuration());

    expect(
      service.canUseMentionChat(
        profile(),
        member([chatbotRoleId, restrictedRoleId]),
        "890123456789012345",
        chatChannelId,
      ),
    ).toBe(false);
    expect(
      service.canUseMentionChat(
        profile(),
        member([restrictedRoleId]),
        ownerId,
        chatChannelId,
      ),
    ).toBe(true);
  });

  it("denies chat outside configured chatbot channels", () => {
    const service = new ChatAccessService(configuration());

    expect(
      service.canUseMentionChat(profile(), member([chatbotRoleId]), "890123456789012345", "999999999999999999"),
    ).toBe(false);
  });

  it("allows bot owners to chat outside configured chatbot channels", () => {
    const service = new ChatAccessService(configuration());

    expect(
      service.canUseMentionChat(profile(), member([]), ownerId, "999999999999999999"),
    ).toBe(true);
  });
});
