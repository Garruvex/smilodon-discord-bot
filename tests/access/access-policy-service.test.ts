import type { ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it } from "vitest";

import { AccessPolicyService } from "../../src/application/access/access-policy-service.js";
import { CommandModule } from "../../src/application/commands/command.js";
import { defaultMemoryEngineLimits } from "../../src/application/memory/memory-engine.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import { AccessDenialReason } from "../../src/domain/access/access-decision.js";
import {
  RoleMatchMode,
  publicAccessPolicy,
} from "../../src/domain/access/access-policy.js";

const guildId = "123456789012345678";
const musicRoleId = "234567890123456789";
const administratorRoleId = "345678901234567890";
const restrictedRoleId = "456789012345678901";
const musicChannelId = "567890123456789012";
const ownerId = "678901234567890123";
const controlPanelChannelId = "901234567890123456";

function applicationConfiguration(): ApplicationConfiguration {
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
    utilityChat: null,
    embeddings: null,
    memory: defaultMemoryEngineLimits,
  };
}

function guildConfiguration(): GuildConfiguration {
  return {
    schemaVersion: 1,
    guildId,
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
      chatbot: false,
      birthdays: false,
      nsfw: false,
      linkFix: false,
      retainMemberDataOnLeave: true,
      ambientReplies: false,
      channelHistory: false,
    },
    roles: {
      botAdministrator: new Set([administratorRoleId]),
      musicController: new Set([musicRoleId]),
      restricted: new Set([restrictedRoleId]),
      chatbot: new Set(),
    },
    channels: {
      musicCommands: new Set([musicChannelId]),
      controlPanel: controlPanelChannelId,
      auditLog: null,
      chatbot: new Set(),
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
      examplesFile: null,
      examplesAsset: null,
      cooldownSeconds: 30,
      deniedMessage: "Premium required.",
      deniedLinkUrl: null,
      deniedLinkLabel: null,
      webSearchMode: "off", toolCallingEnabled: false, disabledTools: [],
      imageInputEnabled: false,
      imageGenerationEnabled: false,
      includeSources: true,
      maxImagesPerRequest: 2,
      ambientCooldownSeconds: 20,
      channelHistoryLimit: 8, channelMemoryModes: {}, personaDriftEnabled: false, contextScanChannelIds: [], contextDailyChannelIds: [], contextSeedDays: 7,
    },
    sourceFile: "test.yaml",
  };
}

function provider(profile: GuildConfiguration | null): GuildConfigurationProvider {
  return {
    initialize: () => Promise.resolve(),
    find: () => profile,
    require: (): GuildConfiguration => {
      if (!profile) throw new Error("Missing profile");
      return profile;
    },
    getAll: () => (profile ? [profile] : []),
    create: () => Promise.reject(new Error("Not implemented in this test.")),
    update: () => Promise.reject(new Error("Not implemented in this test.")),
    reload: () => Promise.resolve(),
  };
}

function interaction(
  roleIds: readonly string[],
  userId = "890123456789012345",
  channelId = musicChannelId,
  botHasPermissions = true,
): ChatInputCommandInteraction {
  return {
    inCachedGuild: () => true,
    guildId,
    channelId,
    user: { id: userId },
    member: {
      roles: { cache: new Map(roleIds.map((roleId) => [roleId, {}])) },
      permissions: { bitfield: -1n },
    },
    guild: {
      members: {
        me: { permissions: { bitfield: botHasPermissions ? -1n : 0n } },
      },
    },
    // Discord computes these directly for the channel the interaction fired
    // in (channel overwrites already folded in), separate from
    // member.permissions/guild.members.me.permissions which are guild-role-
    // only — see access-policy-service.ts. Mirrored here so the fixture
    // matches what a real interaction actually carries.
    memberPermissions: { bitfield: -1n },
    appPermissions: { bitfield: botHasPermissions ? -1n : 0n },
  } as unknown as ChatInputCommandInteraction;
}

const controllerPolicy = {
  ...publicAccessPolicy,
  roles: {
    match: RoleMatchMode.Any,
    requiredGroups: ["musicController" as const],
  },
};

describe("AccessPolicyService", () => {
  it("denies every command in an unconfigured guild", () => {
    const service = new AccessPolicyService(applicationConfiguration(), provider(null));

    expect(
      service.evaluate(publicAccessPolicy, CommandModule.Common, interaction([])),
    ).toEqual({
      allowed: false,
      reason: AccessDenialReason.GuildNotConfigured,
    });
  });

  it("allows an owner-only bootstrap command in an unconfigured guild", () => {
    const service = new AccessPolicyService(applicationConfiguration(), provider(null));
    const bootstrapPolicy = {
      ...publicAccessPolicy,
      allowUnconfiguredGuild: true,
      ownerOnly: true,
    };

    expect(
      service.evaluate(
        bootstrapPolicy,
        CommandModule.Bootstrap,
        interaction([], ownerId),
      ),
    ).toEqual({ allowed: true });
  });

  it("allows a configured music controller", () => {
    const service = new AccessPolicyService(
      applicationConfiguration(),
      provider(guildConfiguration()),
    );

    expect(
      service.evaluate(controllerPolicy, CommandModule.Music, interaction([musicRoleId])),
    ).toEqual({ allowed: true });
  });

  it("allows a bot administrator through music-controller inheritance", () => {
    const service = new AccessPolicyService(
      applicationConfiguration(),
      provider(guildConfiguration()),
    );

    expect(
      service.evaluate(
        controllerPolicy,
        CommandModule.Music,
        interaction([administratorRoleId]),
      ),
    ).toEqual({ allowed: true });
  });

  it("denies a restricted member even when they are a controller", () => {
    const service = new AccessPolicyService(
      applicationConfiguration(),
      provider(guildConfiguration()),
    );

    expect(
      service.evaluate(
        controllerPolicy,
        CommandModule.Music,
        interaction([musicRoleId, restrictedRoleId]),
      ),
    ).toEqual({
      allowed: false,
      reason: AccessDenialReason.RestrictedRole,
    });
  });

  it("allows an owner to bypass the restricted role when enabled", () => {
    const service = new AccessPolicyService(
      applicationConfiguration(),
      provider(guildConfiguration()),
    );

    expect(
      service.evaluate(
        controllerPolicy,
        CommandModule.Music,
        interaction([restrictedRoleId], ownerId),
      ),
    ).toEqual({ allowed: true });
  });

  it("denies music commands outside configured music channels", () => {
    const service = new AccessPolicyService(
      applicationConfiguration(),
      provider(guildConfiguration()),
    );

    expect(
      service.evaluate(
        controllerPolicy,
        CommandModule.Music,
        interaction([musicRoleId], undefined, "901234567890123456"),
      ),
    ).toEqual({
      allowed: false,
      reason: AccessDenialReason.ChannelNotAllowed,
    });
  });

  it("denies slash commands in the music control channel", () => {
    const service = new AccessPolicyService(
      applicationConfiguration(),
      provider(guildConfiguration()),
    );

    expect(
      service.evaluate(
        publicAccessPolicy,
        CommandModule.Common,
        interaction([], undefined, controlPanelChannelId),
      ),
    ).toEqual({
      allowed: false,
      reason: AccessDenialReason.ChannelNotAllowed,
    });
  });

  it("denies an owner-bypassed command when the bot itself lacks the required permission", () => {
    const service = new AccessPolicyService(
      applicationConfiguration(),
      provider(guildConfiguration()),
    );
    const policy = { ...controllerPolicy, requiredBotPermissions: [1n] };

    expect(
      service.evaluate(
        policy,
        CommandModule.Music,
        interaction([], ownerId, musicChannelId, false),
      ),
    ).toEqual({
      allowed: false,
      reason: AccessDenialReason.BotMissingPermission,
    });
  });

  it("does not allow owners to bypass the control-channel restriction", () => {
    const service = new AccessPolicyService(
      applicationConfiguration(),
      provider(guildConfiguration()),
    );

    expect(
      service.evaluate(
        publicAccessPolicy,
        CommandModule.Common,
        interaction([], ownerId, controlPanelChannelId),
      ),
    ).toEqual({
      allowed: false,
      reason: AccessDenialReason.ChannelNotAllowed,
    });
  });
});
