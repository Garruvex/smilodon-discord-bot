import { describe, expect, it } from "vitest";

import { AccessPolicyEngine } from "../../src/application/access/access-policy-engine.js";
import { CommandModule } from "../../src/application/commands/command.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import { AccessDenialReason } from "../../src/domain/access/access-decision.js";
import { RoleMatchMode, publicAccessPolicy } from "../../src/domain/access/access-policy.js";
import type { AccessSubject } from "../../src/domain/access/access-rule.js";

// AccessPolicyService's own tests (access-policy-service.test.ts) exercise
// this same rule chain through a live Discord interaction. These tests
// exercise the engine directly from a plain AccessSubject — the shape a
// chat-tool binding builds (see music-tool-support.ts's
// evaluateMusicToolAccess) with no interaction involved — to confirm the
// engine works standalone, which is the whole point of extracting it.

const guildId = "123456789012345678";
const musicRoleId = "234567890123456789";
const channelId = "345678901234567890";

function subject(overrides: Partial<AccessSubject> = {}): AccessSubject {
  return {
    guildId,
    channelId,
    userId: "456789012345678901",
    roleIds: [musicRoleId],
    memberPermissions: -1n, // all bits set — "has every permission"
    botPermissions: -1n,
    isOwner: false,
    ...overrides,
  };
}

function guildConfiguration(overrides: Partial<GuildConfiguration> = {}): GuildConfiguration {
  return {
    schemaVersion: 1,
    guildId,
    guildName: "Test Guild",
    displayName: "Test Bot",
    embedColor: "#3B82F6",
    idleImageUrl: null,
    idleImageAsset: null,
    panel: { progressBar: { style: "standard", length: 12, customTheme: null } },
    features: {
      common: true, diagnostics: true, music: true, chatbot: false, birthdays: false, reminders: false,
      nsfw: false, linkFix: false, retainMemberDataOnLeave: true, ambientReplies: false,
      channelHistory: false,
    },
    roles: {
      botAdministrator: new Set(),
      musicController: new Set([musicRoleId]),
      restricted: new Set(),
      chatbot: new Set(),
    },
    channels: {
      musicCommands: new Set(),
      controlPanel: null,
      auditLog: null,
      chatbot: new Set(),
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
      djModeEnabled: false,
    openQueueRequestsEnabled: false,
    },
    chat: {
      personalityFile: null, personalityAsset: null, examplesFile: null, examplesAsset: null,
      cooldownSeconds: 30, deniedMessage: "Premium required.", deniedLinkUrl: null, deniedLinkLabel: null,
      webSearchMode: "off", toolCallingEnabled: true, disabledTools: [],
      imageInputEnabled: false, imageGenerationEnabled: false, selfReferenceImageAsset: null, includeSources: true,
      maxImagesPerRequest: 2, ambientCooldownSeconds: 20, channelHistoryLimit: 8, channelMemoryModes: {}, personaDriftEnabled: false, contextScanChannelIds: [], contextDailyChannelIds: [], contextSeedDays: 7,
    },
    sourceFile: "test.yaml",
    ...overrides,
  };
}

const musicPolicy = {
  ...publicAccessPolicy,
  roles: { match: RoleMatchMode.Any, requiredGroups: ["musicController" as const] },
};

describe("AccessPolicyEngine (standalone AccessSubject)", () => {
  it("allows a subject with the required role group in a configured, feature-enabled guild", () => {
    const engine = new AccessPolicyEngine();
    expect(engine.evaluate(subject(), musicPolicy, CommandModule.Music, guildConfiguration()))
      .toEqual({ allowed: true, bypassVoiceChannelCheck: false, allowQueueWithoutVoiceChannel: false });
  });

  it("grants the DJ-mode voice-channel bypass to a musicController member when DJ mode is on", () => {
    const engine = new AccessPolicyEngine();
    const configuration = guildConfiguration({
      music: { ...guildConfiguration().music, djModeEnabled: true },
    });
    expect(engine.evaluate(subject(), musicPolicy, CommandModule.Music, configuration))
      .toEqual({ allowed: true, bypassVoiceChannelCheck: true, allowQueueWithoutVoiceChannel: false });
  });

  it("withholds the DJ-mode bypass from a non-musicController member even when DJ mode is on", () => {
    const engine = new AccessPolicyEngine();
    const configuration = guildConfiguration({
      music: { ...guildConfiguration().music, djModeEnabled: true },
      roles: { ...guildConfiguration().roles, musicController: new Set() },
    });
    const policy = { ...publicAccessPolicy, roles: { match: RoleMatchMode.None, requiredGroups: [] as const } };
    expect(engine.evaluate(subject(), policy, CommandModule.Music, configuration))
      .toEqual({ allowed: true, bypassVoiceChannelCheck: false, allowQueueWithoutVoiceChannel: false });
  });

  it("never grants the bypass outside the Music module, even with DJ mode on", () => {
    const engine = new AccessPolicyEngine();
    const configuration = guildConfiguration({
      music: { ...guildConfiguration().music, djModeEnabled: true },
      features: { ...guildConfiguration().features, common: true },
    });
    expect(engine.evaluate(subject(), musicPolicy, CommandModule.Common, configuration))
      .toEqual({ allowed: true, bypassVoiceChannelCheck: false, allowQueueWithoutVoiceChannel: false });
  });

  it("denies in an unconfigured guild unless the policy allows it", () => {
    const engine = new AccessPolicyEngine();
    expect(engine.evaluate(subject(), musicPolicy, CommandModule.Music, null))
      .toEqual({ allowed: false, reason: AccessDenialReason.GuildNotConfigured });
  });

  it("denies when the guild has the feature disabled", () => {
    const engine = new AccessPolicyEngine();
    const configuration = guildConfiguration({ features: { ...guildConfiguration().features, music: false } });
    expect(engine.evaluate(subject(), musicPolicy, CommandModule.Music, configuration))
      .toEqual({ allowed: false, reason: AccessDenialReason.FeatureDisabled });
  });

  it("denies a subject without the required role group", () => {
    const engine = new AccessPolicyEngine();
    const denied = subject({ roleIds: ["unrelated-role"] });
    expect(engine.evaluate(denied, musicPolicy, CommandModule.Music, guildConfiguration()))
      .toEqual({ allowed: false, reason: AccessDenialReason.MissingRequiredRole });
  });

  it("denies when the bot itself lacks the required permission, even with an owner bypass", () => {
    const engine = new AccessPolicyEngine();
    const policy = { ...musicPolicy, requiredBotPermissions: [1n] };
    const owner = subject({ isOwner: true, botPermissions: 0n });
    expect(engine.evaluate(owner, policy, CommandModule.Music, guildConfiguration()))
      .toEqual({ allowed: false, reason: AccessDenialReason.BotMissingPermission });
  });

  it("denies restricted roles unless the policy grants an owner bypass", () => {
    const engine = new AccessPolicyEngine();
    const restrictedRoleId = "567890123456789012";
    const configuration = guildConfiguration({
      roles: { ...guildConfiguration().roles, restricted: new Set([restrictedRoleId]) },
    });
    const restricted = subject({ roleIds: [musicRoleId, restrictedRoleId] });
    expect(engine.evaluate(restricted, musicPolicy, CommandModule.Music, configuration))
      .toEqual({ allowed: false, reason: AccessDenialReason.RestrictedRole });
  });
});
