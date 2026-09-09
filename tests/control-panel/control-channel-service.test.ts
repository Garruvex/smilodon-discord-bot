import { ButtonStyle, ChannelType, type Message } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.useRealTimers();
});

function guildConfiguration(chatbotEnabled: boolean): GuildConfiguration {
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
      chatbot: chatbotEnabled,
      birthdays: false,
      reminders: false,
      nsfw: false,
      linkFix: false,
      retainMemberDataOnLeave: true,
      ambientReplies: false,
      channelHistory: false,
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
      imageGenerationEnabled: false, selfReferenceImageAsset: null,
      includeSources: true,
      maxImagesPerRequest: 2,
      ambientCooldownSeconds: 20,
      channelHistoryLimit: 8, channelMemoryModes: {}, personaDriftEnabled: false, contextScanChannelIds: [], contextDailyChannelIds: [], contextSeedDays: 7,
    },
    sourceFile: "test.yaml",
  };
}

function createService(chatbotEnabled: boolean): {
  service: ControlChannelService;
  enqueue: ReturnType<typeof vi.fn>;
  getSnapshot: ReturnType<typeof vi.fn>;
} {
  const client = { user: { id: botUserId }, guilds: { cache: new Map() } };
  const configuration = {
    ownerUserIds: new Set<string>(),
    runtimeDataDirectory: "./data/local",
  } as unknown as ApplicationConfiguration;
  const provider = {
    find: () => guildConfiguration(chatbotEnabled),
    getAll: () => [guildConfiguration(chatbotEnabled)],
  } as unknown as GuildConfigurationProvider;
  const stateStore = {
    initialize: vi.fn(),
    find: vi.fn(),
    save: vi.fn(),
  } as unknown as ControlPanelStateStore;
  const getSnapshot = vi.fn(() => null);
  const playerGateway = {
    getSnapshot,
    reconcileVoiceState: vi.fn(() => Promise.resolve(false)),
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
    queuePosition: null,
  });
  const playbackService = { enqueue } as unknown as PlaybackService;
  const logger = { error: vi.fn(), warn: vi.fn() };
  const eventBus = {
    subscribe: vi.fn((): (() => void) => () => undefined),
  } as unknown as MusicEventBus;

  return {
    service: new ControlChannelService(
      client as never,
      configuration,
      provider,
      stateStore,
      playerGateway,
      playbackService,
      { getYohtaTheme: () => null, hasEmoji: () => false } as never,
      logger as never,
      eventBus,
    ),
    enqueue,
    getSnapshot,
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
    member: { roles: { cache: new Map([[musicControllerRoleId, {}]]) }, voice: { channelId: null } },
    reply: vi.fn().mockResolvedValue(statusMessage),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as Message<true>;
}

describe("ControlChannelService", () => {
  it("acknowledges successful controls silently and refreshes the panel", async () => {
    const { service } = createService(false);
    const toggleTwentyFourSeven = vi.fn().mockResolvedValue(true);
    Object.assign(service, {
      playbackService: { toggleTwentyFourSeven },
      stateStore: {
        find: () => ({
          guildId,
          channelId: controlPanelChannelId,
          messageId: "panel-message",
        }),
      },
    });
    const writePanel = vi.spyOn(
      service as unknown as { writePanel: (...args: unknown[]) => Promise<void> },
      "writePanel",
    ).mockResolvedValue(undefined);
    const interaction = {
      customId: "music-panel:v1:24-7",
      inCachedGuild: (): boolean => true,
      guildId,
      channelId: controlPanelChannelId,
      message: { id: "panel-message" },
      member: { roles: { cache: new Map([[musicControllerRoleId, {}]]) }, voice: { channelId: null } },
      user: { id: "345678901234567890" },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };

    await expect(service.handleButton(interaction as never)).resolves.toBe(true);

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(toggleTwentyFourSeven).toHaveBeenCalledOnce();
    // The authoritative render always runs after the action, bypassing the
    // background debounce so the real result lands immediately.
    expect(writePanel).toHaveBeenCalledWith(guildId, expect.anything(), {});
  });

  it("recovers a stale player instead of erroring when 24/7 is disabled after a voice disconnect", async () => {
    const { service } = createService(false);
    const toggleTwentyFourSeven = vi.fn().mockResolvedValue(false);
    const reconcileVoiceState = vi.fn().mockResolvedValue(true);
    Object.assign(service, {
      playbackService: { toggleTwentyFourSeven },
      playerGateway: { getSnapshot: () => null, reconcileVoiceState },
      stateStore: {
        find: () => ({
          guildId,
          channelId: controlPanelChannelId,
          messageId: "panel-message",
        }),
      },
    });
    const writePanel = vi.spyOn(
      service as unknown as { writePanel: (...args: unknown[]) => Promise<void> },
      "writePanel",
    ).mockResolvedValue(undefined);
    const interaction = {
      customId: "music-panel:v1:24-7",
      inCachedGuild: (): boolean => true,
      guildId,
      channelId: controlPanelChannelId,
      message: { id: "panel-message" },
      // The controller is not in the (stale) player's recorded voice
      // channel — exactly the deadlock scenario: this must still succeed.
      member: { roles: { cache: new Map([[musicControllerRoleId, {}]]) }, voice: { channelId: null } },
      user: { id: "345678901234567890" },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };

    await expect(service.handleButton(interaction as never)).resolves.toBe(true);

    expect(reconcileVoiceState).toHaveBeenCalledWith(guildId);
    // The stale session was reset by reconciliation; the 24/7 toggle itself
    // must not run (there's no player left to toggle) and must not error.
    expect(toggleTwentyFourSeven).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining("reset") as string,
      }),
    );
    // The panel is refreshed to idle (snapshot is now null, so every
    // control renders disabled) rather than left showing the stale player.
    expect(writePanel).toHaveBeenCalledWith(guildId, expect.anything(), {});
  });

  it("skips the optimistic pending state for instant local toggles (autoqueue, 24/7)", async () => {
    const { service, getSnapshot } = createService(false);
    const toggleAutoQueue = vi.fn().mockResolvedValue(true);
    getSnapshot.mockReturnValue({
      guildId,
      voiceChannelId: "111111111111111111",
      paused: false,
      playing: true,
      volume: 75,
      queueLength: 0,
      previousTrackCount: 0,
      repeatMode: "off",
      autoQueue: false,
      autoQueueIssue: false,
      twentyFourSeven: false,
      currentTrack: {
        title: "Track",
        author: "Artist",
        uri: "https://example.com/track",
        artworkUrl: null,
        durationMs: 60_000,
        positionMs: 1_000,
        isStream: false,
        requestedByUserId: null,
      },
    });
    Object.assign(service, {
      playbackService: { toggleAutoQueue },
      stateStore: {
        find: () => ({
          guildId,
          channelId: controlPanelChannelId,
          messageId: "panel-message",
        }),
      },
    });
    const writePanel = vi.spyOn(
      service as unknown as { writePanel: (...args: unknown[]) => Promise<void> },
      "writePanel",
    ).mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: "music-panel:v1:autoqueue",
      inCachedGuild: (): boolean => true,
      guildId,
      channelId: controlPanelChannelId,
      message: { id: "panel-message" },
      member: { roles: { cache: new Map([[musicControllerRoleId, {}]]) }, voice: { channelId: null } },
      user: { id: "345678901234567890" },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };

    await service.handleButton(interaction as never);

    // No predicted/disabled intermediate render — the toggle is already an
    // instant local state change, so there's no round trip worth masking.
    expect(editReply).not.toHaveBeenCalled();
    expect(toggleAutoQueue).toHaveBeenCalledOnce();
    // The authoritative render still runs immediately after, showing the
    // real (not predicted) result.
    expect(writePanel).toHaveBeenCalledWith(guildId, expect.anything(), {});
  });

  it("still shows the optimistic disabled prediction for controls that keep a pending phase", async () => {
    const { service, getSnapshot } = createService(false);
    const skip = vi.fn().mockResolvedValue(undefined);
    getSnapshot.mockReturnValue({
      guildId,
      voiceChannelId: "111111111111111111",
      paused: false,
      playing: true,
      volume: 75,
      queueLength: 1,
      previousTrackCount: 0,
      repeatMode: "off",
      autoQueue: false,
      autoQueueIssue: false,
      twentyFourSeven: false,
      currentTrack: {
        title: "Track",
        author: "Artist",
        uri: "https://example.com/track",
        artworkUrl: null,
        durationMs: 60_000,
        positionMs: 1_000,
        isStream: false,
        requestedByUserId: null,
      },
    });
    Object.assign(service, {
      playbackService: { skip },
      stateStore: {
        find: () => ({
          guildId,
          channelId: controlPanelChannelId,
          messageId: "panel-message",
        }),
      },
    });
    vi.spyOn(
      service as unknown as { writePanel: (...args: unknown[]) => Promise<void> },
      "writePanel",
    ).mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: "music-panel:v1:skip",
      inCachedGuild: (): boolean => true,
      guildId,
      channelId: controlPanelChannelId,
      message: { id: "panel-message" },
      member: { roles: { cache: new Map([[musicControllerRoleId, {}]]) }, voice: { channelId: null } },
      user: { id: "345678901234567890" },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };

    await service.handleButton(interaction as never);

    expect(editReply).toHaveBeenCalledOnce();
    const [{ components }] = editReply.mock.calls[0] as [{ components: Array<{ components: Array<{ toJSON: () => { custom_id: string; disabled?: boolean } }> }> }];
    const skipButton = components
      .flatMap((row) => row.components)
      .map((component) => component.toJSON())
      .find((button) => button.custom_id === "music-panel:v1:skip");
    expect(skipButton?.disabled).toBe(true);
    expect(skip).toHaveBeenCalledOnce();
  });

  it("optimistically disables every control instantly when stop is pressed", async () => {
    const { service, getSnapshot } = createService(false);
    const stop = vi.fn().mockResolvedValue(undefined);
    getSnapshot.mockReturnValue({
      guildId,
      voiceChannelId: "111111111111111111",
      paused: false,
      playing: true,
      volume: 75,
      queueLength: 2,
      previousTrackCount: 1,
      repeatMode: "off",
      autoQueue: true,
      autoQueueIssue: false,
      twentyFourSeven: true,
      currentTrack: {
        title: "Track",
        author: "Artist",
        uri: "https://example.com/track",
        artworkUrl: null,
        durationMs: 60_000,
        positionMs: 1_000,
        isStream: false,
        requestedByUserId: null,
      },
    });
    Object.assign(service, {
      playbackService: { stop },
      stateStore: {
        find: () => ({
          guildId,
          channelId: controlPanelChannelId,
          messageId: "panel-message",
        }),
      },
    });
    vi.spyOn(service, "refreshPanel").mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: "music-panel:v1:stop",
      inCachedGuild: (): boolean => true,
      guildId,
      channelId: controlPanelChannelId,
      message: { id: "panel-message" },
      member: { roles: { cache: new Map([[musicControllerRoleId, {}]]) }, voice: { channelId: null } },
      user: { id: "345678901234567890" },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };

    await service.handleButton(interaction as never);

    expect(editReply).toHaveBeenCalledOnce();
    const [{ components }] = editReply.mock.calls[0] as [{ components: Array<{ components: Array<{ toJSON: () => { custom_id: string; disabled?: boolean } }> }> }];
    const buttons = components
      .flatMap((row) => row.components)
      .map((component) => component.toJSON());
    expect(buttons.every((button) => button.disabled)).toBe(true);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("renders enabled session toggles as green controls", () => {
    const { service } = createService(false);
    const payload = (
      service as unknown as {
        createPanelPayload: (
          profile: GuildConfiguration,
          snapshot: unknown,
        ) => { components: Array<{ toJSON: () => { components: Array<{ style?: number }> } }> };
      }
    ).createPanelPayload(guildConfiguration(false), {
      guildId,
      voiceChannelId: "345678901234567890",
      paused: false,
      playing: true,
      volume: 75,
      queueLength: 0,
      previousTrackCount: 0,
      repeatMode: "off",
      autoQueue: true,
      autoQueueIssue: false,
      twentyFourSeven: true,
      currentTrack: {
        title: "Track",
        author: "Artist",
        uri: "https://example.com/track",
        artworkUrl: null,
        durationMs: 60_000,
        positionMs: 10_000,
        isStream: false,
        requestedByUserId: null,
      },
    });
    const secondary = payload.components[1]!.toJSON().components;

    expect(secondary[2]?.style).toBe(ButtonStyle.Success);
    expect(secondary[3]?.style).toBe(ButtonStyle.Success);
  });

  it("disables playback controls while keeping an idle 24/7 session reversible", () => {
    const { service } = createService(false);
    const payload = (
      service as unknown as {
        createPanelPayload: (
          profile: GuildConfiguration,
          snapshot: unknown,
        ) => { components: Array<{ toJSON: () => { components: Array<{ disabled?: boolean }> } }> };
      }
    ).createPanelPayload(guildConfiguration(false), {
      guildId,
      voiceChannelId: "345678901234567890",
      paused: false,
      playing: false,
      volume: 75,
      queueLength: 0,
      previousTrackCount: 0,
      repeatMode: "off",
      autoQueue: false,
      autoQueueIssue: false,
      twentyFourSeven: true,
      currentTrack: null,
    });
    const primary = payload.components[0]!.toJSON().components;
    const secondary = payload.components[1]!.toJSON().components;

    expect(primary.every((button) => button.disabled)).toBe(true);
    expect(secondary[0]?.disabled).toBe(true);
    expect(secondary[1]?.disabled).toBe(true);
    expect(secondary[2]?.disabled).toBe(true);
    expect(secondary[3]?.disabled).toBe(false);
    expect(secondary[4]?.disabled).toBe(true);
  });

  it("shows an up-next preview when the queue is non-empty", () => {
    const { service } = createService(false);
    const getQueue = vi.fn().mockReturnValue([
      { identifier: "a", title: "Track A", author: "Artist A", uri: "https://example.com/a", artworkUrl: null, durationMs: 1000, isStream: false, requestedByUserId: "1" },
      { identifier: "b", title: "Track B", author: "Artist B", uri: "https://example.com/b", artworkUrl: null, durationMs: 1000, isStream: false, requestedByUserId: "1" },
    ]);
    Object.assign(service, { playerGateway: { getQueue } });
    const embed = (
      service as unknown as {
        createPanelEmbed: (
          profile: GuildConfiguration,
          snapshot: unknown,
        ) => { toJSON: () => { fields?: Array<{ name: string; value: string }> } };
      }
    ).createPanelEmbed(guildConfiguration(false), {
      paused: false,
      volume: 75,
      queueLength: 5,
      repeatMode: "off",
      currentTrack: {
        title: "Rice Field",
        author: "Jay Chou",
        uri: "https://example.com/rice-field",
        artworkUrl: "https://example.com/artwork.jpg",
        durationMs: 224_000,
        positionMs: 158_000,
        isStream: false,
        requestedByUserId: "345678901234567890",
      },
    }).toJSON();

    expect(getQueue).toHaveBeenCalledWith(guildId);
    const upNext = embed.fields?.find((field) => field.name === "Up next");
    expect(upNext?.value).toContain("[Track A](https://example.com/a)");
    expect(upNext?.value).toContain("[Track B](https://example.com/b)");
    expect(upNext?.value).toContain("…and 3 more");
  });

  it("keeps artwork prominent and replaces diagnostic fields with compact playback details", () => {
    const { service } = createService(false);
    const embed = (
      service as unknown as {
        createPanelEmbed: (
          profile: GuildConfiguration,
          snapshot: {
            paused: boolean;
            volume: number;
            queueLength: number;
            repeatMode: "off";
            currentTrack: {
              title: string;
              author: string;
              uri: string;
              artworkUrl: string;
              durationMs: number;
              positionMs: number;
              isStream: boolean;
              requestedByUserId: string;
            };
          },
        ) => { toJSON: () => { description?: string; image?: { url: string }; fields?: unknown[]; footer?: { text: string } } };
      }
    ).createPanelEmbed(guildConfiguration(false), {
      paused: false,
      volume: 75,
      queueLength: 0,
      repeatMode: "off",
      currentTrack: {
        title: "Rice Field",
        author: "Jay Chou",
        uri: "https://example.com/rice-field",
        artworkUrl: "https://example.com/artwork.jpg",
        durationMs: 224_000,
        positionMs: 158_000,
        isStream: false,
        requestedByUserId: "345678901234567890",
      },
    }).toJSON();

    expect(embed.image?.url).toBe("https://example.com/artwork.jpg");
    expect(embed.description).toContain("Rice Field");
    expect(embed.description).toContain("Jay Chou");
    expect(embed.description).toContain("▰");
    expect(embed.fields).toBeUndefined();
    expect(embed.footer?.text).toContain("Queue empty");
  });

  it("attributes autoqueued tracks to the bot instead of creating an invalid mention", () => {
    const { service } = createService(false);
    const embed = (
      service as unknown as {
        createPanelEmbed: (
          profile: GuildConfiguration,
          snapshot: unknown,
        ) => { toJSON: () => { description?: string } };
      }
    ).createPanelEmbed(guildConfiguration(false), {
      paused: false,
      volume: 75,
      queueLength: 0,
      repeatMode: "off",
      currentTrack: {
        title: "Recommendation",
        author: "Artist",
        uri: "https://example.com/recommendation",
        artworkUrl: null,
        durationMs: 60_000,
        positionMs: 10_000,
        isStream: false,
        requestedByUserId: "autoqueue",
      },
    }).toJSON();

    expect(embed.description).toContain(`Requested by <@${botUserId}> (Autoqueue)`);
    expect(embed.description).not.toContain("<@autoqueue>");
  });

  it("surfaces a footer note when autoqueue could not find a recommendation", () => {
    const { service } = createService(false);
    const embed = (
      service as unknown as {
        createPanelEmbed: (
          profile: GuildConfiguration,
          snapshot: unknown,
        ) => { toJSON: () => { footer?: { text: string } } };
      }
    ).createPanelEmbed(guildConfiguration(false), {
      paused: false,
      volume: 75,
      queueLength: 0,
      repeatMode: "off",
      autoQueue: true,
      autoQueueIssue: true,
      currentTrack: {
        title: "Track",
        author: "Artist",
        uri: "https://example.com/track",
        artworkUrl: null,
        durationMs: 60_000,
        positionMs: 10_000,
        isStream: false,
        requestedByUserId: null,
      },
    }).toJSON();

    expect(embed.footer?.text).toContain("Autoqueue found nothing to add");
  });

  it("refreshes the panel to current idle state during startup", async () => {
    const { service } = createService(false);
    const ensureGuildPanel = vi
      .spyOn(service, "ensureGuildPanel")
      .mockResolvedValue({} as Message);
    const refreshPanel = vi.spyOn(service, "refreshPanel").mockResolvedValue(undefined);

    await service.initialize();
    service.stop();

    expect(ensureGuildPanel).toHaveBeenCalledWith(guildId);
    expect(refreshPanel).toHaveBeenCalledWith(guildId);
  });

  it("restarts an active guild's five-second progress countdown after a forced refresh", async () => {
    vi.useFakeTimers();
    const { service } = createService(false);
    const refreshPanel = vi.spyOn(service, "refreshPanel").mockResolvedValue(undefined);
    const resetProgressRefreshTimer = (
      service as unknown as {
        resetProgressRefreshTimer: (guildId: string, snapshot: unknown) => void;
      }
    ).resetProgressRefreshTimer.bind(service);
    const activeSnapshot = {
      currentTrack: { title: "Track" },
      playing: true,
      paused: false,
    };

    resetProgressRefreshTimer(guildId, activeSnapshot);
    await vi.advanceTimersByTimeAsync(4_000);
    resetProgressRefreshTimer(guildId, activeSnapshot);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshPanel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(refreshPanel).toHaveBeenCalledOnce();
    expect(refreshPanel).toHaveBeenCalledWith(guildId);
  });

  it("cancels progress countdowns when playback becomes paused or idle", async () => {
    vi.useFakeTimers();
    const { service } = createService(false);
    const refreshPanel = vi.spyOn(service, "refreshPanel").mockResolvedValue(undefined);
    const resetProgressRefreshTimer = (
      service as unknown as {
        resetProgressRefreshTimer: (guildId: string, snapshot: unknown) => void;
      }
    ).resetProgressRefreshTimer.bind(service);

    resetProgressRefreshTimer(guildId, {
      currentTrack: { title: "Track" },
      playing: true,
      paused: false,
    });
    resetProgressRefreshTimer(guildId, {
      currentTrack: { title: "Track" },
      playing: false,
      paused: true,
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(refreshPanel).not.toHaveBeenCalled();
  });

  it("keeps refreshing while a current track is in Lavalink's start transition", async () => {
    vi.useFakeTimers();
    const { service } = createService(false);
    const refreshPanel = vi.spyOn(service, "refreshPanel").mockResolvedValue(undefined);
    const resetProgressRefreshTimer = (
      service as unknown as {
        resetProgressRefreshTimer: (guildId: string, snapshot: unknown) => void;
      }
    ).resetProgressRefreshTimer.bind(service);

    resetProgressRefreshTimer(guildId, {
      currentTrack: { title: "Starting track" },
      playing: false,
      paused: false,
    });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(refreshPanel).toHaveBeenCalledOnce();
    expect(refreshPanel).toHaveBeenCalledWith(guildId);
  });

  it("preserves an existing idle image attachment during refresh", () => {
    const { service } = createService(false);
    const createPanelEditOptions = (
      service as unknown as {
        createPanelEditOptions: (
          message: Message,
          profile: GuildConfiguration,
          snapshot: null,
          payload: { content: string },
        ) => { attachments?: []; files?: unknown[] };
      }
    ).createPanelEditOptions.bind(service);
    const message = {
      attachments: {
        some: (predicate: (attachment: { name: string }) => boolean) =>
          predicate({ name: "music-idle.png" }),
      },
    } as unknown as Message;

    const result = createPanelEditOptions(
      message,
      guildConfiguration(false),
      null,
      { content: "Idle" },
    );

    expect(result).toEqual({ content: "Idle" });
    expect(result).not.toHaveProperty("attachments");
    expect(result).not.toHaveProperty("files");
  });

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
      member: { roles: { cache: new Map() }, voice: { channelId: null } },
      reply,
    } as unknown as Message<true>;

    await expect(service.handleMessage(message)).resolves.toBe(true);

    expect(reply).toHaveBeenCalledWith(
      "You need a music-controller role to request songs.",
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("restores the old panel channel's permissions when the panel moves to a new channel", async () => {
    const oldChannelId = "111111111111111111";
    const oldMessageId = "222222222222222222";
    const everyoneRole = { id: "everyone-role" };

    const oldMessage = {
      author: { id: botUserId },
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const oldChannel = {
      id: oldChannelId,
      type: ChannelType.GuildText,
      isTextBased: (): boolean => true,
      isDMBased: (): boolean => false,
      permissionOverwrites: { edit: vi.fn().mockResolvedValue(undefined) },
      messages: { fetch: vi.fn().mockResolvedValue(oldMessage) },
    };
    const newChannel = {
      id: controlPanelChannelId,
      type: ChannelType.GuildText,
      permissionOverwrites: { edit: vi.fn().mockResolvedValue(undefined) },
      messages: { fetch: vi.fn() },
      send: vi.fn().mockResolvedValue({ id: "333333333333333333" }),
    };
    const guild = {
      id: guildId,
      roles: { everyone: everyoneRole },
      channels: {
        fetch: vi.fn((id: string) =>
          Promise.resolve(id === oldChannelId ? oldChannel : newChannel)),
      },
    };

    const client = { user: { id: botUserId }, guilds: { cache: new Map([[guildId, guild]]) } };
    const configuration = {
      ownerUserIds: new Set<string>(),
      runtimeDataDirectory: "./data/local",
    } as unknown as ApplicationConfiguration;
    const provider = {
      find: () => guildConfiguration(false),
      getAll: () => [guildConfiguration(false)],
    } as unknown as GuildConfigurationProvider;
    const stateStore = {
      initialize: vi.fn(),
      find: vi.fn(() => ({ guildId, channelId: oldChannelId, messageId: oldMessageId })),
      save: vi.fn(),
    } as unknown as ControlPanelStateStore;
    const playerGateway = { getSnapshot: vi.fn(() => null) } as unknown as MusicPlayerGateway;
    const logger = { error: vi.fn(), warn: vi.fn() };
    const eventBus = {
      subscribe: vi.fn((): (() => void) => () => undefined),
    } as unknown as MusicEventBus;

    const service = new ControlChannelService(
      client as never,
      configuration,
      provider,
      stateStore,
      playerGateway,
      { enqueue: vi.fn() } as unknown as PlaybackService,
      { getYohtaTheme: () => null, hasEmoji: () => false } as never,
      logger as never,
      eventBus,
    );

    const ensurePanel = (
      service as unknown as {
        ensurePanel: (profile: GuildConfiguration) => Promise<Message>;
      }
    ).ensurePanel.bind(service);

    await ensurePanel(guildConfiguration(false));

    expect(newChannel.permissionOverwrites.edit).toHaveBeenCalledWith(
      everyoneRole,
      { UseApplicationCommands: false },
      { reason: "Reserve the music control channel for panel controls and song requests" },
    );
    expect(oldChannel.permissionOverwrites.edit).toHaveBeenCalledWith(
      everyoneRole,
      { UseApplicationCommands: null },
      { reason: "Music control channel is no longer reserved for the panel" },
    );
    expect(oldMessage.delete).toHaveBeenCalledOnce();
  });

  it("serializes an in-flight background refresh against a button's optimistic edit, so an older write can't land after a newer one", async () => {
    const messageId = "444444444444444444";
    const order: string[] = [];

    let releaseBackgroundEdit!: () => void;
    const backgroundEditGate = new Promise<void>((resolve) => { releaseBackgroundEdit = resolve; });

    const message = {
      id: messageId,
      pinned: true,
      author: { id: botUserId },
      attachments: { some: (): boolean => false },
      edit: vi.fn(async (): Promise<void> => {
        order.push("background-edit-start");
        await backgroundEditGate;
        order.push("background-edit-done");
      }),
    };
    const channel = {
      id: controlPanelChannelId,
      type: ChannelType.GuildText,
      permissionOverwrites: { edit: vi.fn().mockResolvedValue(undefined) },
      messages: { fetch: vi.fn().mockResolvedValue(message) },
    };
    const guild = {
      id: guildId,
      roles: { everyone: { id: "everyone-role" } },
      channels: { fetch: vi.fn().mockResolvedValue(channel) },
    };

    const client = { user: { id: botUserId }, guilds: { cache: new Map([[guildId, guild]]) } };
    const configuration = {
      ownerUserIds: new Set<string>(),
      runtimeDataDirectory: "./data/local",
    } as unknown as ApplicationConfiguration;
    const profile = guildConfiguration(false);
    const provider = {
      find: () => profile,
      getAll: () => [profile],
    } as unknown as GuildConfigurationProvider;
    const stateStore = {
      initialize: vi.fn(),
      find: vi.fn(() => ({ guildId, channelId: controlPanelChannelId, messageId })),
      save: vi.fn(),
    } as unknown as ControlPanelStateStore;
    const snapshot = {
      guildId,
      voiceChannelId: "111111111111111111",
      paused: false,
      playing: true,
      volume: 75,
      queueLength: 1,
      previousTrackCount: 0,
      repeatMode: "off" as const,
      autoQueue: false,
      autoQueueIssue: false,
      twentyFourSeven: false,
      currentTrack: {
        title: "Track",
        author: "Artist",
        uri: "https://example.com/track",
        artworkUrl: null,
        durationMs: 60_000,
        positionMs: 1_000,
        isStream: false,
        requestedByUserId: null,
      },
    };
    const skip = vi.fn().mockResolvedValue(undefined);
    const playerGateway = {
      getSnapshot: vi.fn(() => snapshot),
      reconcileVoiceState: vi.fn(() => Promise.resolve(false)),
      getQueue: vi.fn(() => []),
      getPlayHistory: vi.fn(() => []),
    } as unknown as MusicPlayerGateway;
    const logger = { error: vi.fn(), warn: vi.fn() };
    const eventBus = {
      subscribe: vi.fn((): (() => void) => () => undefined),
    } as unknown as MusicEventBus;

    const service = new ControlChannelService(
      client as never,
      configuration,
      provider,
      stateStore,
      playerGateway,
      { skip } as unknown as PlaybackService,
      { getYohtaTheme: () => null, hasEmoji: () => false } as never,
      logger as never,
      eventBus,
    );

    // Kick off a background refresh (e.g. a trackStart event elsewhere) and
    // let it get as far as an in-flight, not-yet-resolved message.edit call.
    const backgroundRefresh = service.refreshPanel(guildId, { immediate: true });
    await vi.waitFor(() => expect(message.edit).toHaveBeenCalledOnce());

    const editReply = vi.fn((): Promise<void> => {
      order.push("optimistic-editReply");
      return Promise.resolve();
    });
    const interaction = {
      customId: "music-panel:v1:skip",
      inCachedGuild: (): boolean => true,
      guildId,
      channelId: controlPanelChannelId,
      message: { id: messageId },
      member: { roles: { cache: new Map([[musicControllerRoleId, {}]]) }, voice: { channelId: null } },
      user: { id: "345678901234567890" },
      deferUpdate: vi.fn().mockResolvedValue(undefined),
      editReply,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };

    // The click happens while the background write is still in flight.
    const buttonHandled = service.handleButton(interaction as never);
    await Promise.resolve();
    await Promise.resolve();

    // The optimistic write must not have jumped the queue while the older
    // background write is still pending.
    expect(order).toEqual(["background-edit-start"]);

    releaseBackgroundEdit();
    await backgroundRefresh;
    await buttonHandled;

    expect(order[0]).toBe("background-edit-start");
    expect(order[1]).toBe("background-edit-done");
    expect(order[2]).toBe("optimistic-editReply");
    expect(skip).toHaveBeenCalledOnce();
  });
});
