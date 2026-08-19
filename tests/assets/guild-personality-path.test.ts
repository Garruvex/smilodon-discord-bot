import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isSafePersonalityFileReference,
  resolveGuildPersonalityPath,
} from "../../src/application/assets/guild-personality-path.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";

function profile(overrides: Partial<GuildConfiguration["chat"]> = {}): GuildConfiguration {
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
      music: false,
      chatbot: true,
      birthdays: false,
      nsfw: false,
      linkFix: false,
      retainMemberDataOnLeave: true,
      ambientReplies: false,
      channelHistory: false,
    },
    roles: {
      botAdministrator: new Set(),
      musicController: new Set(),
      restricted: new Set(),
      chatbot: new Set(),
    },
    channels: {
      musicCommands: new Set(),
      controlPanel: null,
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
      cooldownSeconds: 30,
      deniedMessage: "Premium required.",
      deniedLinkUrl: null,
      deniedLinkLabel: null,
      webSearchMode: "off",
      imageInputEnabled: false,
      imageGenerationEnabled: false,
      includeSources: true,
      maxImagesPerRequest: 2,
      ambientCooldownSeconds: 20,
      channelHistoryLimit: 8,
      ...overrides,
    },
    sourceFile: "test.yaml",
  };
}

describe("guild personality path helpers", () => {
  it("rejects traversal and absolute personality file references", () => {
    expect(isSafePersonalityFileReference("../secrets.md")).toBe(false);
    expect(isSafePersonalityFileReference("/etc/passwd.md")).toBe(false);
    expect(isSafePersonalityFileReference("personalities/guild.md")).toBe(true);
  });

  it("resolves uploaded personality assets inside runtime storage", () => {
    const runtimeDirectory = "./data/runtime";
    const path = resolveGuildPersonalityPath(
      profile({ personalityAsset: "guild-assets/123456789012345678/personality.md" }),
      runtimeDirectory,
    );

    expect(path).toBe(
      resolve(runtimeDirectory, "guild-assets/123456789012345678/personality.md"),
    );
  });

  it("returns null for unsafe personality file references", () => {
    expect(
      resolveGuildPersonalityPath(
        profile({ personalityFile: "../../.env.md" }),
        "./data/runtime",
      ),
    ).toBeNull();
  });
});
