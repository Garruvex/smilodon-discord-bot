import { describe, expect, it, vi } from "vitest";

import type { ControlChannelService } from "../../src/application/control-panel/control-channel-service.js";
import { SettingsCommand } from "../../src/infrastructure/discord/commands/setup/settings-command.js";
import { formatAuditSummary } from "../../src/infrastructure/discord/commands/setup/settings/audit-setting.js";
import { resolveGuildEmoji, validateRoleGroupUpdate } from "../../src/infrastructure/discord/commands/setup/settings/settings-support.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { CommandContext } from "../../src/application/commands/command.js";

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
      retainMemberDataOnLeave: true,
      ambientReplies: false,
      channelHistory: false,
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
      ambientCooldownSeconds: 20,
      channelHistoryLimit: 8,
    },
    sourceFile: "test.yaml",
  };
}

// Minimal fake CommandContext for exercising SettingsCommand.execute() end to
// end — options() returns the requested option values, responses.edit
// captures the final message.
function fakeContext(subcommand: string, options: Record<string, unknown> = {}): {
  context: CommandContext;
  edited: { text: string | null };
} {
  const edited: { text: string | null } = { text: null };
  const context = {
    interaction: {
      guildId: profile().guildId,
      user: { id: "890123456789012345" },
      options: {
        getSubcommand: () => subcommand,
        getString: (name: string) => (options[name] as string | undefined) ?? null,
        getInteger: (name: string) => (options[name] as number | undefined) ?? null,
        getBoolean: (name: string) => (options[name] as boolean | undefined) ?? null,
        getChannel: (name: string) => (options[name] as { id: string } | undefined) ?? null,
        getRole: (name: string) => (options[name] as { id: string } | undefined) ?? null,
        getAttachment: () => null,
      },
      guild: null,
    },
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    responses: {
      defer: vi.fn(() => Promise.resolve()),
      edit: vi.fn((text: string) => {
        edited.text = text;
        return Promise.resolve();
      }),
      reply: vi.fn(() => Promise.resolve()),
    },
  } as unknown as CommandContext;
  return { context, edited };
}

function providerWith(current: GuildConfiguration): GuildConfigurationProvider {
  let stored = current;
  return {
    initialize: () => Promise.resolve(),
    find: () => stored,
    require: () => stored,
    getAll: () => [stored],
    create: () => Promise.resolve(stored),
    update: (_guildId: string, input): Promise<GuildConfiguration> => {
      stored = {
        ...stored,
        music: { ...stored.music, ...(input.defaultVolume !== undefined ? { defaultVolume: input.defaultVolume } : {}) },
        chat: { ...stored.chat, ...(input.chatbotCooldownSeconds !== undefined ? { cooldownSeconds: input.chatbotCooldownSeconds } : {}) },
      };
      return Promise.resolve(stored);
    },
    reload: () => Promise.resolve(),
  };
}

describe("SettingsCommand", () => {
  it("exposes a per-guild image-generation toggle", () => {
    const command = new SettingsCommand({} as never, {} as never, applicationEmojiCatalog as never);
    const definition = command.definition.toJSON();
    const chatGroup = definition.options?.find((option) => option.name === "chat");
    const chatbot = chatGroup && "options" in chatGroup
      ? chatGroup.options?.find((option: { name: string }) => option.name === "chatbot")
      : undefined;

    expect(chatbot && "options" in chatbot
      ? chatbot.options?.map((option: { name: string }) => option.name)
      : []).toContain("image-generation");
  });

  it("rejects removing the last music-controller role while music is enabled", () => {
    const validation = validateRoleGroupUpdate(profile(), "musicController", new Set());
    expect(validation).toContain("music-controller");
  });

  it("rejects removing the last chatbot role while chatbot is enabled", () => {
    const enabledProfile = { ...profile(), features: { ...profile().features, chatbot: true } };
    const validation = validateRoleGroupUpdate(enabledProfile, "chatbot", new Set());
    expect(validation).toContain("chatbot");
  });

  it("describes a specific field change instead of a generic confirmation", async () => {
    const command = new SettingsCommand(providerWith(profile()), {} as never, applicationEmojiCatalog as never);
    const { context, edited } = fakeContext("volume", { default: 90 });

    await command.execute(context);
    expect(edited.text).toContain("Default volume: 75 → 90");
  });

  it("warns when a chatbot setting changes while the chatbot feature is disabled", async () => {
    const command = new SettingsCommand(providerWith(profile()), {} as never, applicationEmojiCatalog as never);
    const { context, edited } = fakeContext("chatbot", { "cooldown-seconds": 60 });

    await command.execute(context);
    expect(edited.text).toContain("Chatbot cooldown (seconds): 30 → 60");
    expect(edited.text).toContain("currently disabled");
  });

  it("resolves custom emojis by mention or local name", () => {
    const guildId = profile().guildId;
    const emoji = {
      id: "777777777777777777",
      name: "runner",
      animated: true,
      available: true,
      guild: { id: guildId },
    };

    expect(resolveGuildEmoji(guildId, [emoji].values() as never, "runner")).toEqual({
      id: emoji.id,
      name: "runner",
      animated: true,
      scope: "guild",
      guildId,
    });
    expect(resolveGuildEmoji(guildId, [emoji].values() as never, `<a:runner:${emoji.id}>`))
      .toEqual(expect.objectContaining({ id: emoji.id, animated: true }));
  });

  it("tells the admin to configure a channel when audit logging isn't set up", async () => {
    const auditLogService = { fetchRecent: vi.fn().mockResolvedValue({ configured: false, entries: [] }) };

    const summary = await formatAuditSummary(auditLogService as never, "guild-id", 10);

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

    const summary = await formatAuditSummary(auditLogService as never, "guild-id", 10);

    expect(summary).toContain("Recent audit log entries:");
    expect(summary).toContain("Default volume: 75 → 90");
    expect(summary).not.toContain("\n\n");
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
});
