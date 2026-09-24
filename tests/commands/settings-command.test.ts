import { describe, expect, it, vi } from "vitest";

import type { ChatToolRegistry } from "../../src/application/chat/tools/chat-tool-registry.js";
import type { ControlChannelService } from "../../src/application/control-panel/control-channel-service.js";
import { SettingsUpdateService } from "../../src/application/settings/settings-update-service.js";
import { LegacySettingsCommand } from "../../src/infrastructure/discord/settings/legacy-settings-command.js";
import { settingGroups, type SettingGroup } from "../../src/infrastructure/discord/settings/definitions/index.js";
import type { GuildAssetStore } from "../../src/application/assets/guild-asset-store.js";
import { LegacySettingsEngine } from "../../src/infrastructure/discord/settings/legacy-settings-engine.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider, UpdateGuildConfigurationInput } from "../../src/config/guild-configuration-provider.js";
import type { CommandContext } from "../../src/application/commands/command.js";

// The group still run by the legacy engine; the rest are in the settings
// registry (see settings-groups.test.ts).
const chatGroup = settingGroups.find((group) => group.name === "chat")!;

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
      reminders: false,
      nsfw: false,
      linkFix: false,
      retainMemberDataOnLeave: true,
      ambientReplies: false,
      channelHistory: false, reactionReplies: false, historyReactions: false,
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
      adminPanel: null,
      chatbot: new Set(),
      birthdayAnnouncements: null,
      joinAnnouncements: null,
      leaveAnnouncements: null,
      linkFix: new Set(),
    },
    timezone: "UTC",
    language: "en",
    linkFixPlatforms: {
      twitter: true, threads: true, tiktok: true, instagram: true, reddit: true, bilibili: true,
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
      djModeEnabled: false,
    openQueueRequestsEnabled: false,
    autoQueueVoteEnabled: true,
    autoQueueVoteBarStyle: "squares", autoQueueVoteOptionCount: 3,
    },
    chat: {
      personalityFile: null,
      personalityAsset: null,
      examplesFile: null,
      examplesAsset: null,
      cooldownSeconds: 30,
      deniedMessage: "Denied",
      deniedLinkUrl: null,
      deniedLinkLabel: null,
      webSearchMode: "off", toolCallingEnabled: false, disabledTools: [],
      imageInputEnabled: false,
      imageGenerationEnabled: false, selfReferenceImageAsset: null,
      includeSources: true,
      maxImagesPerRequest: 2,
      ambientCooldownSeconds: 20,
      channelHistoryLimit: 8, channelMemoryModes: {}, personaDriftEnabled: false, contextScanChannelIds: [], contextDailyChannelIds: [], contextSeedDays: 7,
    },
    sourceFile: "test.yaml",
  };
}

// Minimal fake CommandContext for exercising SettingsCommand.execute() end to
// end — options() returns the requested option values, responses.edit
// captures the final message.
// A legacy /settings-<group> command over its own engine, wired the way
// dependencies.ts does.
function settingsCommand(
  group: SettingGroup,
  profiles: GuildConfigurationProvider,
  assets: GuildAssetStore,
  options: { chatToolRegistry?: ChatToolRegistry; channelSummaryProviderAvailable?: boolean } = {},
): LegacySettingsCommand {
  const engine = new LegacySettingsEngine({
    profiles,
    assets,
    applicationEmojiCatalog: applicationEmojiCatalog as never,
    channelSummaryProviderAvailable: options.channelSummaryProviderAvailable ?? false,
  }, new SettingsUpdateService(profiles, assets));
  if (options.chatToolRegistry) engine.bindChatToolRegistry(options.chatToolRegistry);
  return new LegacySettingsCommand(group, engine);
}

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
        getAttachment: (name: string) => (options[name] as { url: string } | undefined) ?? null,
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
        ...(input.language !== undefined ? { language: input.language } : {}),
        music: { ...stored.music, ...(input.defaultVolume !== undefined ? { defaultVolume: input.defaultVolume } : {}) },
        chat: {
          ...stored.chat,
          ...(input.chatbotCooldownSeconds !== undefined ? { cooldownSeconds: input.chatbotCooldownSeconds } : {}),
          ...(input.chatbotDisabledToolNames !== undefined ? { disabledTools: [...input.chatbotDisabledToolNames] } : {}),
          ...(input.chatbotSelfReferenceImageAsset !== undefined
            ? { selfReferenceImageAsset: input.chatbotSelfReferenceImageAsset }
            : {}),
          ...(input.contextScanAddChannelId !== undefined
            ? { contextScanChannelIds: [...new Set([...stored.chat.contextScanChannelIds, input.contextScanAddChannelId])] }
            : {}),
          ...(input.contextDailyAddChannelId !== undefined
            ? { contextDailyChannelIds: [...new Set([...stored.chat.contextDailyChannelIds, input.contextDailyAddChannelId])] }
            : {}),
        },
      };
      return Promise.resolve(stored);
    },
    reload: () => Promise.resolve(),
  };
}

// Runs one write through SettingsUpdateService (what SettingsCommand uses
// after a setting's handle()) with a stub control panel attached.
async function applyWithPanel(input: UpdateGuildConfigurationInput): Promise<{
  refreshPanel: ReturnType<typeof vi.fn>;
  ensureGuildPanel: ReturnType<typeof vi.fn>;
}> {
  const refreshPanel = vi.fn().mockResolvedValue(undefined);
  const ensureGuildPanel = vi.fn().mockResolvedValue(undefined);
  const updater = new SettingsUpdateService(providerWith(profile()), {} as never);
  updater.bindControlChannelService({ refreshPanel, ensureGuildPanel } as unknown as ControlChannelService);
  await updater.apply({
    guildId: profile().guildId,
    actorUserId: "890123456789012345",
    auditHeading: "test",
    input,
    describe: () => "",
  });
  return { refreshPanel, ensureGuildPanel };
}

describe("SettingsCommand", () => {
  it("exposes a per-guild image-generation toggle", () => {
    const command = settingsCommand(chatGroup, {} as never, {} as never);
    const definition = command.definition;
    const chatbot = definition.subcommands?.find((subcommand) => subcommand.name === "chatbot");

    expect(chatbot?.options?.map((option) => option.name) ?? []).toContain("image-generation");
  });

  it("warns when a chatbot setting changes while the chatbot feature is disabled", async () => {
    const command = settingsCommand(chatGroup, providerWith(profile()), {} as never);
    const { context, edited } = fakeContext("chatbot", { "cooldown-seconds": 60 });

    await command.execute(context);
    expect(edited.text).toContain("Chatbot cooldown (seconds): 30 → 60");
    expect(edited.text).toContain("currently disabled");
  });

  it("rejects disabling an unknown tool name", async () => {
    const chatToolRegistry = { list: () => [{ name: "play_music", description: "Plays music." }] } as unknown as ChatToolRegistry;
    const command = settingsCommand(chatGroup, providerWith(profile()), {} as never, { chatToolRegistry: chatToolRegistry });
    const { context, edited } = fakeContext("tools-disable", { name: "unknown_tool" });

    await command.execute(context);

    expect(edited.text).toContain("Unknown tool");
    expect(edited.text).toContain("play_music");
  });

  it("disables and re-enables a chat tool by name, validated against the live registry", async () => {
    const chatToolRegistry = {
      list: () => [{ name: "play_music", description: "Plays music." }],
    } as unknown as ChatToolRegistry;
    const provider = providerWith(profile());
    const command = settingsCommand(chatGroup, provider, {} as never, { chatToolRegistry: chatToolRegistry });

    const disable = fakeContext("tools-disable", { name: "play_music" });
    await command.execute(disable.context);
    expect(disable.edited.text).toContain("Disabled chat tools: play_music");
    expect(provider.require("").chat.disabledTools).toEqual(["play_music"]);

    const enable = fakeContext("tools-enable", { name: "play_music" });
    await command.execute(enable.context);
    expect(enable.edited.text).toContain("Disabled chat tools: none");
    expect(provider.require("").chat.disabledTools).toEqual([]);
  });

  it("lists registered chat tools and whether each is enabled for the guild", async () => {
    const chatToolRegistry = {
      list: () => [{ name: "play_music", description: "Plays a song." }, { name: "roll_dice", description: "Rolls dice." }],
    } as unknown as ChatToolRegistry;
    const disabledProfile = { ...profile(), chat: { ...profile().chat, disabledTools: ["roll_dice"] } };
    const command = settingsCommand(chatGroup, providerWith(disabledProfile), {} as never, { chatToolRegistry: chatToolRegistry });
    const { context, edited } = fakeContext("tools-list");

    await command.execute(context);

    expect(edited.text).toContain("🟢 **play_music**");
    expect(edited.text).toContain("🔴 **roll_dice**");
  });

  it("truncates long tool descriptions so the listing stays under Discord's 2000-char message limit", async () => {
    const chatToolRegistry = {
      list: () => Array.from({ length: 15 }, (_, index) => ({
        name: `tool_${index}`,
        description: "A very long description that keeps going on and on to describe exactly what this tool does ".repeat(3),
      })),
    } as unknown as ChatToolRegistry;
    const command = settingsCommand(chatGroup, providerWith(profile()), {} as never, { chatToolRegistry: chatToolRegistry });
    const { context, edited } = fakeContext("tools-list");

    await command.execute(context);

    expect(edited.text?.length).toBeLessThanOrEqual(2000);
    expect(edited.text).toContain("🟢 **tool_0**");
  });

  it("uploads a self-reference image and stores its asset path", async () => {
    const saveSelfReferenceImage = vi.fn(() => Promise.resolve("guild-assets/123456789012345678/self-reference.png"));
    const assets = { saveSelfReferenceImage, removeSelfReferenceImage: vi.fn() };
    const provider = providerWith(profile());
    const command = settingsCommand(chatGroup, provider, assets as never);
    const { context, edited } = fakeContext("chatbot", { "self-reference-image": { url: "https://example.com/ref.png" } });

    await command.execute(context);

    expect(saveSelfReferenceImage).toHaveBeenCalledWith(profile().guildId, { url: "https://example.com/ref.png" });
    expect(provider.require("").chat.selfReferenceImageAsset).toBe("guild-assets/123456789012345678/self-reference.png");
    expect(edited.text).toContain("Chatbot self-reference image");
  });

  it("removes the self-reference image and deletes the old file", async () => {
    const removeSelfReferenceImage = vi.fn(() => Promise.resolve());
    const assets = { saveSelfReferenceImage: vi.fn(), removeSelfReferenceImage };
    const existingProfile = {
      ...profile(),
      chat: { ...profile().chat, selfReferenceImageAsset: "guild-assets/123456789012345678/self-reference.png" },
    };
    const provider = providerWith(existingProfile);
    const command = settingsCommand(chatGroup, provider, assets as never);
    const { context } = fakeContext("chatbot", { "remove-self-reference-image": true });

    await command.execute(context);

    expect(provider.require("").chat.selfReferenceImageAsset).toBeNull();
    expect(removeSelfReferenceImage).toHaveBeenCalledWith("guild-assets/123456789012345678/self-reference.png");
  });

  it("rejects providing both a self-reference upload and its removal", async () => {
    const assets = { saveSelfReferenceImage: vi.fn(), removeSelfReferenceImage: vi.fn() };
    const command = settingsCommand(chatGroup, providerWith(profile()), assets as never);
    const { context, edited } = fakeContext("chatbot", {
      "self-reference-image": { url: "https://example.com/ref.png" },
      "remove-self-reference-image": true,
    });

    await command.execute(context);

    expect(edited.text).toContain("either a self-reference image upload or removing it");
    expect(assets.saveSelfReferenceImage).not.toHaveBeenCalled();
  });

  it("rejects context-scan-add when no chat provider supports channel summarization", async () => {
    const command = settingsCommand(chatGroup, providerWith(profile()), {} as never, { channelSummaryProviderAvailable: false });
    const { context, edited } = fakeContext("context-scan-add", { channel: { id: "999888777666555444" } });

    await command.execute(context);

    expect(edited.text).toContain("can't be queued");
  });

  it("rejects context-daily-add when no chat provider supports channel summarization", async () => {
    const command = settingsCommand(chatGroup, providerWith(profile()), {} as never, { channelSummaryProviderAvailable: false });
    const { context, edited } = fakeContext("context-daily-add", { channel: { id: "999888777666555444" } });

    await command.execute(context);

    expect(edited.text).toContain("can't be queued");
  });

  it("queues context-scan-add when a summarization-capable provider is configured, noting the paused chatbot feature", async () => {
    const command = settingsCommand(chatGroup, providerWith(profile()), {} as never, { channelSummaryProviderAvailable: true });
    const { context, edited } = fakeContext("context-scan-add", { channel: { id: "999888777666555444" } });

    await command.execute(context);

    expect(edited.text).toContain("queued for a one-time history scan");
    expect(edited.text).toContain("currently disabled");
  });


  it("refreshes the panel immediately after idle-image settings change", async () => {
    const { refreshPanel, ensureGuildPanel } = await applyWithPanel({ idleImageAsset: "guild-assets/123456789012345678/idle.png" });

    expect(refreshPanel).toHaveBeenCalledWith(profile().guildId, {
      forceIdleImage: true,
      immediate: true,
    });
    expect(ensureGuildPanel).not.toHaveBeenCalled();
  });

  it("refreshes the panel immediately after progress settings change", async () => {
    const { refreshPanel } = await applyWithPanel({ progressBar: { style: "yohta", length: 12, customTheme: null } });

    expect(refreshPanel).toHaveBeenCalledWith(profile().guildId, {
      forceIdleImage: false,
      immediate: true,
    });
  });

  describe("language", () => {



    it("refreshes the panel immediately so it switches language without waiting for playback", async () => {
      const { refreshPanel } = await applyWithPanel({ language: "ja" });

      expect(refreshPanel).toHaveBeenCalledWith(profile().guildId, { immediate: true });
    });
  });
});
