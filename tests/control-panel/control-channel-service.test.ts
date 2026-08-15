import type { Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { ControlChannelService } from "../../src/application/control-panel/control-channel-service.js";
import type { PlaybackService } from "../../src/application/music/playback-service.js";
import type { MusicEventBus } from "../../src/application/music/music-event-bus.js";
import type { MusicPlayerGateway } from "../../src/application/music/music-player-gateway.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import type { ControlPanelStateStore } from "../../src/application/control-panel/control-panel-state-store.js";

const guildId = "123456789012345678";
const controlPanelChannelId = "901234567890123456";
const botUserId = "789012345678901234";
const musicControllerRoleId = "234567890123456789";

function guildConfiguration(chatbotEnabled: boolean): GuildConfiguration {
  return {
    schemaVersion: 1,
    guildId,
    guildName: "Test Guild",
    displayName: "Test Bot",
    embedColor: "#3B82F6",
    idleImageUrl: null,
    idleImageAsset: null,
    features: {
      common: true,
      diagnostics: true,
      music: true,
      chatbot: chatbotEnabled,
    },
    roles: {
      botAdministrator: new Set(),
      musicController: new Set([musicControllerRoleId]),
      restricted: new Set(),
      chatbot: new Set(),
    },
    channels: {
      musicCommands: new Set(),
      controlPanel: controlPanelChannelId,
      auditLog: null,
      chatbot: new Set(),
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
      webSearchEnabled: false,
      imageInputEnabled: false,
      includeSources: true,
      maxImagesPerRequest: 2,
    },
    sourceFile: "test.yaml",
  };
}

function createService(chatbotEnabled: boolean): {
  service: ControlChannelService;
  enqueue: ReturnType<typeof vi.fn>;
} {
  const client = { user: { id: botUserId } };
  const configuration = {
    ownerUserIds: new Set<string>(),
    runtimeDataDirectory: "./data/local",
  } as unknown as ApplicationConfiguration;
  const provider = {
    find: () => guildConfiguration(chatbotEnabled),
  } as unknown as GuildConfigurationProvider;
  const stateStore = {
    initialize: vi.fn(),
    find: vi.fn(),
    save: vi.fn(),
  } as unknown as ControlPanelStateStore;
  const playerGateway = {
    getSnapshot: vi.fn(() => null),
  } as unknown as MusicPlayerGateway;
  const enqueue = vi.fn().mockResolvedValue({
    firstTrack: {
      identifier: "track-id",
      title: "Track",
      author: "Artist",
      uri: "https://example.com/track",
      artworkUrl: null,
      durationMs: 60_000,
      isStream: false,
      requestedByUserId: "345678901234567890",
    },
    addedTrackCount: 1,
    startedPlayback: true,
  });
  const playbackService = { enqueue } as unknown as PlaybackService;
  const logger = { error: vi.fn(), warn: vi.fn() };
  const eventBus = { subscribe: vi.fn() } as unknown as MusicEventBus;

  return {
    service: new ControlChannelService(
      client as never,
      configuration,
      provider,
      stateStore,
      playerGateway,
      playbackService,
      logger as never,
      eventBus,
    ),
    enqueue,
  };
}

function mentionMessage(): Message<true> {
  const statusMessage = {
    edit: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return {
    inGuild: () => true,
    guildId,
    channelId: controlPanelChannelId,
    author: { bot: false, id: "345678901234567890" },
    webhookId: null,
    content: `<@${botUserId}> what is 2+2?`,
    mentions: { users: new Map([[botUserId, {}]]) },
    member: { roles: { cache: new Map([[musicControllerRoleId, {}]]) } },
    reply: vi.fn().mockResolvedValue(statusMessage),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as Message<true>;
}

describe("ControlChannelService", () => {
  it("ignores bot mentions so mention-chat can handle them", async () => {
    const { service, enqueue } = createService(true);

    await expect(service.handleMessage(mentionMessage())).resolves.toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("still treats a mention as a song request when chatbot is disabled", async () => {
    const { service, enqueue } = createService(false);

    await expect(service.handleMessage(mentionMessage())).resolves.toBe(true);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ guildId }),
      "what is 2+2?",
    );
  });

  it("deletes mention-only messages instead of searching when chatbot is disabled", async () => {
    const { service, enqueue } = createService(false);
    const deleteMessage = vi.fn().mockResolvedValue(undefined);
    const message = {
      ...mentionMessage(),
      content: `<@${botUserId}>`,
      reply: vi.fn(),
      delete: deleteMessage,
    } as unknown as Message<true>;

    await expect(service.handleMessage(message)).resolves.toBe(true);

    expect(deleteMessage).toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("denies typed song requests without a music-controller role", async () => {
    const { service, enqueue } = createService(false);
    const deniedMessage = { delete: vi.fn().mockResolvedValue(undefined) };
    const reply = vi.fn().mockResolvedValue(deniedMessage);
    const message = {
      ...mentionMessage(),
      content: "song name",
      mentions: { users: new Map() },
      member: { roles: { cache: new Map() } },
      reply,
    } as unknown as Message<true>;

    await expect(service.handleMessage(message)).resolves.toBe(true);

    expect(reply).toHaveBeenCalledWith(
      "You need a music-controller role to request songs.",
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
