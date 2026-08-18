import { describe, expect, it, vi } from "vitest";

import type { ControlChannelService } from "../../src/application/control-panel/control-channel-service.js";
import { SettingsCommand } from "../../src/infrastructure/discord/commands/setup/settings-command.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";

const applicationEmojiCatalog = {
  getYohtaTheme: (): null => null,
  getMissingYohtaEmojiNames: (): string[] => ["progressed"],
};

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
      chatbot: false,
      birthdays: false,
      nsfw: false,
      linkFix: false,
    },
    roles: {
      botAdministrator: new Set(["345678901234567890"]),
      musicController: new Set(["456789012345678901"]),
      restricted: new Set(["567890123456789012"]),
      chatbot: new Set(),
    },
    channels: {
      musicCommands: new Set(),
      controlPanel: "901234567890123456",
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
      deniedMessage: "Denied",
      deniedLinkUrl: null,
      deniedLinkLabel: null,
      webSearchMode: "off",
      imageInputEnabled: false,
      imageGenerationEnabled: false,
      includeSources: true,
      maxImagesPerRequest: 2,
    },
    sourceFile: "test.yaml",
  };
}

describe("SettingsCommand", () => {
  it("exposes a per-guild image-generation toggle", () => {
    const command = new SettingsCommand({} as never, {} as never, applicationEmojiCatalog as never);
    const definition = command.definition.toJSON();
    const chatbot = definition.options?.find((option) => option.name === "chatbot");

    expect(chatbot && "options" in chatbot
      ? chatbot.options?.map((option) => option.name)
      : []).toContain("image-generation");
  });

  it("rejects removing the last music-controller role while music is enabled", () => {
    const command = new SettingsCommand({} as never, {} as never, applicationEmojiCatalog as never);
    const validation = (
      command as unknown as {
        validateRoleGroupUpdate: (
          profile: GuildConfiguration,
          group: "musicController",
          nextRoleIds: ReadonlySet<string>,
        ) => string | null;
      }
    ).validateRoleGroupUpdate(profile(), "musicController", new Set());

    expect(validation).toContain("music-controller");
  });

  it("rejects removing the last chatbot role while chatbot is enabled", () => {
    const command = new SettingsCommand({} as never, {} as never, applicationEmojiCatalog as never);
    const enabledProfile = { ...profile(), features: { ...profile().features, chatbot: true } };
    const validation = (
      command as unknown as {
        validateRoleGroupUpdate: (
          profile: GuildConfiguration,
          group: "chatbot",
          nextRoleIds: ReadonlySet<string>,
        ) => string | null;
      }
    ).validateRoleGroupUpdate(enabledProfile, "chatbot", new Set());

    expect(validation).toContain("chatbot");
  });

  it("describes a specific field change instead of a generic confirmation", () => {
    const command = new SettingsCommand({} as never, {} as never, applicationEmojiCatalog as never);
    const previous = profile();
    const updated = { ...previous, music: { ...previous.music, defaultVolume: 90 } };

    const description = (
      command as unknown as {
        describeUpdate: (
          subcommand: string,
          previous: GuildConfiguration,
          updated: GuildConfiguration,
        ) => string;
      }
    ).describeUpdate("volume", previous, updated);

    expect(description).toContain("Default volume: 75 → 90");
  });

  it("warns when a chatbot setting changes while the chatbot feature is disabled", () => {
    const command = new SettingsCommand({} as never, {} as never, applicationEmojiCatalog as never);
    const previous = profile();
    const updated = { ...previous, chat: { ...previous.chat, cooldownSeconds: 60 } };

    const description = (
      command as unknown as {
        describeUpdate: (
          subcommand: string,
          previous: GuildConfiguration,
          updated: GuildConfiguration,
        ) => string;
      }
    ).describeUpdate("chatbot", previous, updated);

    expect(description).toContain("Chatbot cooldown (seconds): 30 → 60");
    expect(description).toContain("currently disabled");
  });

  it("refreshes the panel immediately after idle-image settings change", async () => {
    const command = new SettingsCommand({} as never, {} as never, applicationEmojiCatalog as never);
    const refreshPanel = vi.fn().mockResolvedValue(undefined);
    const ensureGuildPanel = vi.fn().mockResolvedValue(undefined);
    command.bindControlChannelService({
      refreshPanel,
      ensureGuildPanel,
    } as unknown as ControlChannelService);

    await (
      command as unknown as {
        syncControlPanel: (
          guildId: string,
          subcommand: string,
          input: { idleImageAsset?: string },
          profile: GuildConfiguration,
        ) => Promise<void>;
      }
    ).syncControlPanel(
      profile().guildId,
      "panel",
      { idleImageAsset: "guild-assets/123456789012345678/idle.png" },
      profile(),
    );

    expect(refreshPanel).toHaveBeenCalledWith(profile().guildId, { forceIdleImage: true });
    expect(ensureGuildPanel).not.toHaveBeenCalled();
  });

  it("refreshes the panel immediately after progress settings change", async () => {
    const command = new SettingsCommand({} as never, {} as never, applicationEmojiCatalog as never);
    const refreshPanel = vi.fn().mockResolvedValue(undefined);
    command.bindControlChannelService({
      refreshPanel,
      ensureGuildPanel: vi.fn(),
    } as unknown as ControlChannelService);

    await (
      command as unknown as {
        syncControlPanel: (
          guildId: string,
          subcommand: string,
          input: { progressBar?: GuildConfiguration["panel"]["progressBar"] },
          profile: GuildConfiguration,
        ) => Promise<void>;
      }
    ).syncControlPanel(
      profile().guildId,
      "panel",
      { progressBar: { style: "yohta", length: 12, customTheme: null } },
      profile(),
    );

    expect(refreshPanel).toHaveBeenCalledWith(profile().guildId, {
      forceIdleImage: false,
    });
  });

  it("resolves custom emojis by mention or local name", () => {
    const command = new SettingsCommand({} as never, {} as never, applicationEmojiCatalog as never);
    const guildId = profile().guildId;
    const emoji = {
      id: "777777777777777777",
      name: "runner",
      animated: true,
      available: true,
      guild: { id: guildId },
    };
    const resolveGuildEmoji = (
      command as unknown as {
        resolveGuildEmoji: (
          guildId: string,
          emojis: IterableIterator<unknown>,
          input: string,
        ) => { id: string; name: string; animated: boolean; scope: "guild"; guildId: string };
      }
    ).resolveGuildEmoji.bind(command);

    expect(resolveGuildEmoji(guildId, [emoji].values(), "runner")).toEqual({
      id: emoji.id,
      name: "runner",
      animated: true,
      scope: "guild",
      guildId,
    });
    expect(resolveGuildEmoji(guildId, [emoji].values(), `<a:runner:${emoji.id}>`))
      .toEqual(expect.objectContaining({ id: emoji.id, animated: true }));
  });

  it("tells the admin to configure a channel when audit logging isn't set up", async () => {
    const auditLogService = { fetchRecent: vi.fn().mockResolvedValue({ configured: false, entries: [] }) };
    const command = new SettingsCommand({} as never, {} as never, applicationEmojiCatalog as never, auditLogService as never);

    const summary = await (
      command as unknown as { formatAuditSummary: (guildId: string, count: number) => Promise<string> }
    ).formatAuditSummary("guild-id", 10);

    expect(auditLogService.fetchRecent).toHaveBeenCalledWith("guild-id", 10);
    expect(summary).toContain("No audit log channel is configured");
  });

  it("lists recent audit log entries as relative timestamps", async () => {
    const auditLogService = {
      fetchRecent: vi.fn().mockResolvedValue({
        configured: true,
        entries: [{ description: "**<@1>**\n**/settings volume**\nDefault volume: 75 → 90", createdAt: 1_700_000_000_000 }],
      }),
    };
    const command = new SettingsCommand({} as never, {} as never, applicationEmojiCatalog as never, auditLogService as never);

    const summary = await (
      command as unknown as { formatAuditSummary: (guildId: string, count: number) => Promise<string> }
    ).formatAuditSummary("guild-id", 10);

    expect(summary).toContain("Recent audit log entries:");
    expect(summary).toContain("Default volume: 75 → 90");
    expect(summary).not.toContain("\n\n");
  });
});
