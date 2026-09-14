import { ButtonStyle, ChannelType, DiscordAPIError, RESTJSONErrorCodes, type Message } from "discord.js";
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
    getQueue: vi.fn(() => []),
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
  const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
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
      { getYohtaTheme: () => null, hasEmoji: () => false, getEmojiTag: () => null } as never,
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
          queueMessageId: "panel-message",
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
          queueMessageId: "panel-message",
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

  it("still reconciles the panel and replies with an error when reconcileVoiceState itself throws", async () => {
    // Regression: reconcileVoiceState used to run outside the try/finally,
    // so a throw there (e.g. a transient Discord API error) skipped the
    // authoritative writePanel() and the error reply entirely — leaving the
    // button stuck showing its optimistic "pending" state with no
    // explanation and no way to recover except a later, unrelated refresh.
    const { service } = createService(false);
    const toggleTwentyFourSeven = vi.fn().mockResolvedValue(false);
    const reconcileVoiceState = vi.fn().mockRejectedValue(new Error("guild cache miss"));
    Object.assign(service, {
      playbackService: { toggleTwentyFourSeven },
      playerGateway: { getSnapshot: () => null, reconcileVoiceState },
      stateStore: {
        find: () => ({
          guildId,
          channelId: controlPanelChannelId,
          queueMessageId: "panel-message",
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

    expect(toggleTwentyFourSeven).not.toHaveBeenCalled();
    expect(interaction.followUp).toHaveBeenCalledWith(
      expect.objectContaining({ content: "The control failed." }),
    );
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
          queueMessageId: "panel-message",
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
          queueMessageId: "panel-message",
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

  it("uses the single-round-trip fast ack when nothing is queued for the guild", async () => {
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
          queueMessageId: "panel-message",
        }),
      },
    });
    vi.spyOn(
      service as unknown as { writePanel: (...args: unknown[]) => Promise<void> },
      "writePanel",
    ).mockResolvedValue(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    const deferUpdate = vi.fn().mockResolvedValue(undefined);
    const editReply = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: "music-panel:v1:skip",
      inCachedGuild: (): boolean => true,
      guildId,
      channelId: controlPanelChannelId,
      message: { id: "panel-message" },
      member: { roles: { cache: new Map([[musicControllerRoleId, {}]]) }, voice: { channelId: null } },
      user: { id: "345678901234567890" },
      update,
      deferUpdate,
      editReply,
      reply: vi.fn().mockResolvedValue(undefined),
      followUp: vi.fn().mockResolvedValue(undefined),
      replied: false,
      deferred: true,
    };

    await service.handleButton(interaction as never);

    // The pending state and the interaction ack land in one call — no
    // separate deferUpdate()/editReply() round trip when the guild's queues
    // are idle.
    expect(update).toHaveBeenCalledOnce();
    expect(deferUpdate).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
    const [{ components }] = update.mock.calls[0] as [{ components: Array<{ components: Array<{ toJSON: () => { custom_id: string; disabled?: boolean } }> }> }];
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
          queueMessageId: "panel-message",
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
        createQueueControlsPayload: (
          profile: GuildConfiguration,
          snapshot: unknown,
        ) => { components: Array<{ toJSON: () => { components: Array<{ style?: number }> } }> };
      }
    ).createQueueControlsPayload(guildConfiguration(false), {
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
        createQueueControlsPayload: (
          profile: GuildConfiguration,
          snapshot: unknown,
        ) => { components: Array<{ toJSON: () => { components: Array<{ disabled?: boolean }> } }> };
      }
    ).createQueueControlsPayload(guildConfiguration(false), {
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

  it("shows a queue preview with requesters and a total duration when the queue is non-empty", () => {
    const { service } = createService(false);
    const getQueue = vi.fn().mockReturnValue([
      { identifier: "a", title: "Track A", author: "Artist A", uri: "https://example.com/a", artworkUrl: null, durationMs: 60_000, isStream: false, requestedByUserId: "111111111111111111" },
      { identifier: "b", title: "Track B", author: "Artist B", uri: "https://example.com/b", artworkUrl: null, durationMs: 90_000, isStream: false, requestedByUserId: "autoqueue" },
    ]);
    Object.assign(service, { playerGateway: { getQueue } });
    const embed = (
      service as unknown as {
        createQueueEmbed: (
          profile: GuildConfiguration,
          snapshot: unknown,
        ) => { toJSON: () => { description?: string } };
      }
    ).createQueueEmbed(guildConfiguration(false), {
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
    expect(embed.description).toContain("5 in queue");
    expect(embed.description).toContain("2m30s");
    expect(embed.description).toContain("[Track A](https://example.com/a) — <@111111111111111111>");
    expect(embed.description).toContain("[Track B](https://example.com/b) — Autoqueue");
  });

  it("truncates the queue preview with a pointer to /queue show once the char budget runs out", () => {
    const { service } = createService(false);
    const longTitleTrack = {
      identifier: "x",
      title: "X".repeat(60),
      author: "Artist",
      uri: "https://example.com/x",
      artworkUrl: null,
      durationMs: 60_000,
      isStream: false,
      requestedByUserId: "111111111111111111",
    };
    // Comfortably enough ~60-char lines to blow through the 3,500-char
    // budget without needing an unreasonably large mock array.
    const tracks = Array.from({ length: 80 }, () => longTitleTrack);
    Object.assign(service, { playerGateway: { getQueue: vi.fn(() => tracks) } });
    const embed = (
      service as unknown as {
        createQueueEmbed: (
          profile: GuildConfiguration,
          snapshot: unknown,
        ) => { toJSON: () => { description?: string } };
      }
    ).createQueueEmbed(guildConfiguration(false), {
      paused: false,
      volume: 75,
      queueLength: tracks.length,
      repeatMode: "off",
      currentTrack: null,
    }).toJSON();

    expect(embed.description).toMatch(/…and \d+ more — use `\/queue show` for the rest/);
  });

  it("keeps the Now Playing embed to artwork and compact playback details, with no footer or queue info", () => {
    const { service } = createService(false);
    const embed = (
      service as unknown as {
        createNowPlayingEmbed: (
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
    ).createNowPlayingEmbed(guildConfiguration(false), {
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
    expect(embed.footer).toBeUndefined();
  });

  it("attributes autoqueued tracks to the bot instead of creating an invalid mention", () => {
    const { service } = createService(false);
    const embed = (
      service as unknown as {
        createNowPlayingEmbed: (
          profile: GuildConfiguration,
          snapshot: unknown,
        ) => { toJSON: () => { description?: string } };
      }
    ).createNowPlayingEmbed(guildConfiguration(false), {
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

  it("surfaces a footer note on the queue embed when autoqueue could not find a recommendation", () => {
    const { service } = createService(false);
    Object.assign(service, { playerGateway: { getQueue: vi.fn(() => []) } });
    const embed = (
      service as unknown as {
        createQueueEmbed: (
          profile: GuildConfiguration,
          snapshot: unknown,
        ) => { toJSON: () => { footer?: { text: string } } };
      }
    ).createQueueEmbed(guildConfiguration(false), {
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

  it("shows the upcoming lines when no line has started yet (e.g. still in the intro)", () => {
    const { service } = createService(false);
    const embed = (
      service as unknown as {
        createLyricsEmbed: (
          profile: GuildConfiguration,
          snapshot: unknown,
        ) => { toJSON: () => { description?: string } };
      }
    ).createLyricsEmbed(guildConfiguration(false), {
      currentTrack: { title: "Track" },
      currentLyricLine: null,
      upcomingLyricLines: ["First line", "Second line"],
      lyricsUnavailable: false,
    }).toJSON();

    expect(embed.description).toBe("-# First line\n-# Second line");
  });

  it("falls back to a placeholder when there's neither a current nor an upcoming line", () => {
    const { service } = createService(false);
    const embed = (
      service as unknown as {
        createLyricsEmbed: (
          profile: GuildConfiguration,
          snapshot: unknown,
        ) => { toJSON: () => { description?: string } };
      }
    ).createLyricsEmbed(guildConfiguration(false), {
      currentTrack: { title: "Track" },
      currentLyricLine: null,
      upcomingLyricLines: [],
      lyricsUnavailable: false,
    }).toJSON();

    expect(embed.description).toBe("Looking for lyrics…");
  });

  it("shows the not-found placeholder once lyrics are confirmed unavailable", () => {
    const { service } = createService(false);
    const embed = (
      service as unknown as {
        createLyricsEmbed: (
          profile: GuildConfiguration,
          snapshot: unknown,
        ) => { toJSON: () => { description?: string } };
      }
    ).createLyricsEmbed(guildConfiguration(false), {
      currentTrack: { title: "Track" },
      currentLyricLine: null,
      upcomingLyricLines: [],
      lyricsUnavailable: true,
    }).toJSON();

    expect(embed.description).toBe("No lyrics found for this track.");
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

  it("refreshes at the next lyric boundary without waiting for the progress interval", async () => {
    vi.useFakeTimers();
    const { service } = createService(false);
    const internals = service as unknown as {
      writeTimedPanels: (id: string) => Promise<void>;
      resetProgressRefreshTimer: (id: string, snapshot: unknown) => void;
    };
    const refresh = vi.spyOn(internals, "writeTimedPanels").mockResolvedValue(undefined);
    internals.resetProgressRefreshTimer(guildId, {
      currentTrack: { title: "Track" }, paused: false, nextLyricLineInMs: 400,
    });
    await vi.advanceTimersByTimeAsync(399);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledOnce();
    service.stop();
  });

  it("coalesces rapid lyric boundaries instead of editing on every line", async () => {
    vi.useFakeTimers();
    const { service } = createService(false);
    const internals = service as unknown as {
      lastLyricsEditAt: Map<string, number>;
      writeTimedPanels: (id: string) => Promise<void>;
      resetProgressRefreshTimer: (id: string, snapshot: unknown) => void;
    };
    const refresh = vi.spyOn(internals, "writeTimedPanels").mockResolvedValue(undefined);
    internals.lastLyricsEditAt.set(guildId, Date.now());
    internals.resetProgressRefreshTimer(guildId, {
      currentTrack: { title: "Track" }, paused: false, nextLyricLineInMs: 100,
    });
    // Back at the 3s floor (matching activePlaybackRefreshIntervalMs) after
    // two separate attempts at a smaller one (1s, then 1.5s) were each
    // confirmed via production REST response logging to trigger real 429s
    // from Discord's per-channel message-edit sublimit — see the comment on
    // minimumLyricEditIntervalMs.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledOnce();
    service.stop();
  });

  it("writes lyrics after slow artwork, off the position after the edit, and reschedules from it too", async () => {
    // Regression: lyrics used to be written BEFORE the (potentially slow)
    // Now Playing edit, off whatever snapshot was current at the start of
    // the cycle — so a slow artwork edit could leave the displayed lyric
    // line stale by however long that edit took, with nothing correcting it
    // until the next tick. Writing lyrics last, off the freshest snapshot,
    // closes that gap.
    vi.useFakeTimers();
    const { service, getSnapshot } = createService(false);
    const internals = service as unknown as {
      ensurePanelMessages: () => Promise<unknown>;
      writeTimedPanels: (id: string) => Promise<void>;
      writeLyricsMessage: (message: unknown, profile: unknown, snapshot: unknown) => Promise<void>;
      writeNowPlayingMessage: () => Promise<void>;
      resetProgressRefreshTimer: (id: string, snapshot: unknown) => void;
    };
    const initial = { currentTrack: { title: "Track" }, paused: false, nextLyricLineInMs: 3_000 };
    const latest = { ...initial, nextLyricLineInMs: 500 };
    getSnapshot.mockReturnValue(initial);
    vi.spyOn(internals, "ensurePanelMessages").mockResolvedValue({ nowPlaying: {}, lyrics: {} });
    const order: string[] = [];
    const lyricsSnapshots: unknown[] = [];
    vi.spyOn(internals, "writeLyricsMessage").mockImplementation((_message, _profile, snapshot) => {
      order.push("lyrics");
      lyricsSnapshots.push(snapshot);
      return Promise.resolve();
    });
    vi.spyOn(internals, "writeNowPlayingMessage").mockImplementation(async () => {
      order.push("artwork");
      await vi.advanceTimersByTimeAsync(2_500);
      getSnapshot.mockReturnValue(latest);
    });
    const reset = vi.spyOn(internals, "resetProgressRefreshTimer");
    await internals.writeTimedPanels(guildId);
    expect(order).toEqual(["artwork", "lyrics"]);
    expect(lyricsSnapshots).toEqual([latest]);
    expect(reset).toHaveBeenLastCalledWith(guildId, latest);
    service.stop();
  });

  it("restarts an active guild's five-second progress countdown after a forced refresh", async () => {
    vi.useFakeTimers();
    const { service } = createService(false);
    const writeTimedPanels = vi.spyOn(
      service as unknown as { writeTimedPanels: (guildId: string) => Promise<void> },
      "writeTimedPanels",
    ).mockResolvedValue(undefined);
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
    await vi.advanceTimersByTimeAsync(2_000);
    resetProgressRefreshTimer(guildId, activeSnapshot);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(writeTimedPanels).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeTimedPanels).toHaveBeenCalledOnce();
    expect(writeTimedPanels).toHaveBeenCalledWith(guildId);
  });

  it("recreates the lyrics message when the track changes, but reuses it while the track stays the same", async () => {
    // The fix for a real production 429 storm: a single lyrics message,
    // edited many times over a long session, was confirmed (via REST
    // response logging) to trip an undocumented Discord per-message
    // sublimit. Rotating the message per track bounds how much edit
    // history any one message can accumulate.
    const { service } = createService(false);
    const internals = service as unknown as {
      ensureLyricsMessage: (
        channel: unknown,
        profile: unknown,
        snapshot: unknown,
        guildId: string,
      ) => Promise<{ message: unknown; justCreated: boolean }>;
    };
    const profile = guildConfiguration(false);
    const trackA = { title: "Song A", author: "Artist A", uri: "https://example.com/a" };
    const trackB = { title: "Song B", author: "Artist B", uri: "https://example.com/b" };
    const firstMessage = { id: "lyrics-a", delete: vi.fn().mockResolvedValue(undefined) };
    const secondMessage = { id: "lyrics-b", delete: vi.fn().mockResolvedValue(undefined) };
    const send = vi.fn()
      .mockResolvedValueOnce(firstMessage)
      .mockResolvedValueOnce(secondMessage);
    const channel = { send };

    const first = await internals.ensureLyricsMessage(
      channel, profile, { currentTrack: trackA, upcomingLyricLines: [] }, guildId,
    );
    expect(first.justCreated).toBe(true);
    expect(first.message).toBe(firstMessage);
    expect(send).toHaveBeenCalledOnce();

    // Same track (position ticking, nothing else) — no recreation.
    const second = await internals.ensureLyricsMessage(
      channel, profile, { currentTrack: { ...trackA }, upcomingLyricLines: [] }, guildId,
    );
    expect(second.justCreated).toBe(false);
    expect(second.message).toBe(firstMessage);
    expect(send).toHaveBeenCalledOnce();
    expect(firstMessage.delete).not.toHaveBeenCalled();

    // A new track — the old message is deleted and a fresh one sent.
    const third = await internals.ensureLyricsMessage(
      channel, profile, { currentTrack: trackB, upcomingLyricLines: [] }, guildId,
    );
    expect(third.justCreated).toBe(true);
    expect(third.message).toBe(secondMessage);
    expect(firstMessage.delete).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("doesn't create a lyrics message while nothing is playing, and cleans up a leftover one once playback stops", async () => {
    // Regression: bot startup (and any "queue emptied, nothing next" point)
    // used to still send a lyrics message just to say "Nothing is playing
    // right now" — which then got immediately deleted and resent the
    // moment a real track actually started. No message is needed while
    // idle at all.
    const { service } = createService(false);
    const internals = service as unknown as {
      ensureLyricsMessage: (
        channel: unknown,
        profile: unknown,
        snapshot: unknown,
        guildId: string,
      ) => Promise<{ message: unknown; justCreated: boolean }>;
    };
    const profile = guildConfiguration(false);
    const send = vi.fn();
    const channel = { send };

    const idleAtStartup = await internals.ensureLyricsMessage(channel, profile, null, guildId);
    expect(idleAtStartup.message).toBeNull();
    expect(idleAtStartup.justCreated).toBe(false);
    expect(send).not.toHaveBeenCalled();

    const track = { title: "Song", author: "Artist", uri: "https://example.com/song" };
    const playing = { id: "lyrics-song", delete: vi.fn().mockResolvedValue(undefined) };
    send.mockResolvedValueOnce(playing);
    const whilePlaying = await internals.ensureLyricsMessage(
      channel, profile, { currentTrack: track, upcomingLyricLines: [] }, guildId,
    );
    expect(whilePlaying.message).toBe(playing);
    expect(whilePlaying.justCreated).toBe(true);

    // Track ends, nothing queued next — the now-stale message is cleaned
    // up, not left to show stale/wrong lyrics indefinitely.
    const idleAfterTrackEnds = await internals.ensureLyricsMessage(channel, profile, null, guildId);
    expect(idleAfterTrackEnds.message).toBeNull();
    expect(playing.delete).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it("sweeps the control channel of anything that isn't a known panel message", async () => {
    // Backstop for stray messages: a self-deletion timer lost to a restart,
    // a failed best-effort delete, or content from before the bot ever
    // touched the channel. Deletes regardless of author — the channel is
    // reserved for the panel (see ensureChannelPermissions).
    const { service } = createService(false);
    const internals = service as unknown as {
      sweepControlChannel: (channel: unknown, keep: ReadonlySet<string>) => Promise<void>;
    };
    const keep1 = { id: "keep-1", delete: vi.fn().mockResolvedValue(undefined) };
    const keep2 = { id: "keep-2", delete: vi.fn().mockResolvedValue(undefined) };
    const stray1 = { id: "stray-1", delete: vi.fn().mockResolvedValue(undefined) };
    const stray2 = { id: "stray-2", delete: vi.fn().mockResolvedValue(undefined) };
    const channel = {
      id: controlPanelChannelId,
      messages: {
        fetch: vi.fn().mockResolvedValue(new Map([
          [keep1.id, keep1],
          [stray1.id, stray1],
          [keep2.id, keep2],
          [stray2.id, stray2],
        ])),
      },
    };

    await internals.sweepControlChannel(channel, new Set([keep1.id, keep2.id]));

    expect(keep1.delete).not.toHaveBeenCalled();
    expect(keep2.delete).not.toHaveBeenCalled();
    expect(stray1.delete).toHaveBeenCalledOnce();
    expect(stray2.delete).toHaveBeenCalledOnce();
  });

  it("cancels progress countdowns when playback becomes paused or idle", async () => {
    vi.useFakeTimers();
    const { service } = createService(false);
    const writeTimedPanels = vi.spyOn(
      service as unknown as { writeTimedPanels: (guildId: string) => Promise<void> },
      "writeTimedPanels",
    ).mockResolvedValue(undefined);
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

    expect(writeTimedPanels).not.toHaveBeenCalled();
  });

  it("keeps refreshing while a current track is in Lavalink's start transition", async () => {
    vi.useFakeTimers();
    const { service } = createService(false);
    const writeTimedPanels = vi.spyOn(
      service as unknown as { writeTimedPanels: (guildId: string) => Promise<void> },
      "writeTimedPanels",
    ).mockResolvedValue(undefined);
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

    expect(writeTimedPanels).toHaveBeenCalledOnce();
    expect(writeTimedPanels).toHaveBeenCalledWith(guildId);
  });

  it("preserves an existing idle image attachment during refresh", () => {
    const { service } = createService(false);
    const createNowPlayingEditOptions = (
      service as unknown as {
        createNowPlayingEditOptions: (
          message: Message,
          profile: GuildConfiguration,
          snapshot: null,
          payload: { content: string },
        ) => { attachments?: []; files?: unknown[] };
      }
    ).createNowPlayingEditOptions.bind(service);
    const message = {
      attachments: {
        some: (predicate: (attachment: { name: string }) => boolean) =>
          predicate({ name: "music-idle.png" }),
      },
    } as unknown as Message;

    const result = createNowPlayingEditOptions(
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
      send: vi.fn().mockResolvedValue({
        id: "333333333333333333",
        pin: vi.fn().mockResolvedValue(undefined),
      }),
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
      find: vi.fn(() => ({
        guildId,
        channelId: oldChannelId,
        nowPlayingMessageId: oldMessageId,
        lyricsMessageId: null,
        queueMessageId: null,
      })),
      save: vi.fn(),
    } as unknown as ControlPanelStateStore;
    const playerGateway = {
      getSnapshot: vi.fn(() => null),
      getQueue: vi.fn(() => []),
    } as unknown as MusicPlayerGateway;
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
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
      { getYohtaTheme: () => null, hasEmoji: () => false, getEmojiTag: () => null } as never,
      logger as never,
      eventBus,
    );

    const ensurePanelMessages = (
      service as unknown as {
        ensurePanelMessages: (profile: GuildConfiguration) => Promise<unknown>;
      }
    ).ensurePanelMessages.bind(service);

    await ensurePanelMessages(guildConfiguration(false));

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
    const nowPlayingMessageId = "444444444444444444";
    const lyricsMessageId = "555555555555555555";
    const queueMessageId = "666666666666666666";
    const order: string[] = [];

    let releaseBackgroundEdit!: () => void;
    const backgroundEditGate = new Promise<void>((resolve) => { releaseBackgroundEdit = resolve; });

    // Only the Now Playing message's edit is gated — it's the first of the
    // three writePanel() edits, so blocking it is enough to prove the whole
    // write turn (all three messages) stays serialized against a concurrent
    // click, without needing every message to replicate the gate.
    const nowPlayingMessage = {
      id: nowPlayingMessageId,
      pinned: true,
      author: { id: botUserId },
      attachments: { some: (): boolean => false, size: 0 },
      content: "",
      embeds: [],
      components: [],
      edit: vi.fn(async (): Promise<void> => {
        order.push("background-edit-start");
        await backgroundEditGate;
        order.push("background-edit-done");
      }),
    };
    const lyricsMessage = {
      id: lyricsMessageId,
      author: { id: botUserId },
      attachments: { size: 0 },
      content: "",
      embeds: [],
      components: [],
      edit: vi.fn().mockResolvedValue(undefined),
    };
    const queueMessage = {
      id: queueMessageId,
      author: { id: botUserId },
      attachments: { size: 0 },
      content: "",
      embeds: [],
      components: [],
      edit: vi.fn().mockResolvedValue(undefined),
    };
    const channel = {
      id: controlPanelChannelId,
      type: ChannelType.GuildText,
      permissionOverwrites: { edit: vi.fn().mockResolvedValue(undefined) },
      messages: {
        fetch: vi.fn((id: string) => Promise.resolve(
          id === nowPlayingMessageId ? nowPlayingMessage
            : id === lyricsMessageId ? lyricsMessage
              : id === queueMessageId ? queueMessage
                : null,
        )),
      },
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
      find: vi.fn(() => ({
        guildId,
        channelId: controlPanelChannelId,
        nowPlayingMessageId,
        lyricsMessageId,
        queueMessageId,
      })),
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
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
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
      { getYohtaTheme: () => null, hasEmoji: () => false, getEmojiTag: () => null } as never,
      logger as never,
      eventBus,
    );

    // Kick off a background refresh (e.g. a trackStart event elsewhere) and
    // let it get as far as an in-flight, not-yet-resolved message.edit call.
    const backgroundRefresh = service.refreshPanel(guildId, { immediate: true });
    await vi.waitFor(() => expect(nowPlayingMessage.edit).toHaveBeenCalledOnce());

    const editReply = vi.fn((): Promise<void> => {
      order.push("optimistic-editReply");
      return Promise.resolve();
    });
    // Not used — with panelWriteQueue busy, the fast-ack path must not even
    // attempt update() (see the assertion below), falling back to
    // deferUpdate()+editReply() so the pending write stays behind the
    // in-flight background one instead of racing it.
    const update = vi.fn().mockResolvedValue(undefined);
    const interaction = {
      customId: "music-panel:v1:skip",
      inCachedGuild: (): boolean => true,
      guildId,
      channelId: controlPanelChannelId,
      message: { id: queueMessageId },
      member: { roles: { cache: new Map([[musicControllerRoleId, {}]]) }, voice: { channelId: null } },
      user: { id: "345678901234567890" },
      update,
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
    expect(update).not.toHaveBeenCalled();

    releaseBackgroundEdit();
    await backgroundRefresh;
    await buttonHandled;

    expect(order[0]).toBe("background-edit-start");
    expect(order[1]).toBe("background-edit-done");
    expect(order[2]).toBe("optimistic-editReply");
    expect(skip).toHaveBeenCalledOnce();
  });

  it("writeTimedPanels edits Now Playing, sends a fresh Lyrics message, never touches Queue", async () => {
    // Lyrics is no longer part of the reused now-playing/queue pair (see
    // ensureLyricsMessage) — a fresh service instance has nothing cached
    // for it yet, so the first cycle sends a brand new message rather than
    // fetching/editing one by a persisted id.
    const nowPlayingMessageId = "777777777777777777";
    const queueMessageId = "999999999999999999";

    function messageMock(): {
      id: string; author: { id: string }; attachments: { size: number; some: () => boolean };
      content: string; embeds: unknown[]; components: unknown[]; edit: ReturnType<typeof vi.fn>;
    } {
      return {
        id: "",
        author: { id: botUserId },
        attachments: { size: 0, some: (): boolean => false },
        content: "",
        embeds: [],
        components: [],
        edit: vi.fn().mockResolvedValue(undefined),
      };
    }
    const nowPlayingMessage = { ...messageMock(), id: nowPlayingMessageId };
    const queueMessage = { ...messageMock(), id: queueMessageId };
    const sentLyricsMessage = { ...messageMock(), id: "new-lyrics-message-id" };
    const send = vi.fn().mockResolvedValue(sentLyricsMessage);

    const channel = {
      id: controlPanelChannelId,
      type: ChannelType.GuildText,
      permissionOverwrites: { edit: vi.fn().mockResolvedValue(undefined) },
      messages: {
        fetch: vi.fn((id: string) => Promise.resolve(
          id === nowPlayingMessageId ? nowPlayingMessage
            : id === queueMessageId ? queueMessage
              : null,
        )),
      },
      send,
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
      find: vi.fn(() => ({
        guildId,
        channelId: controlPanelChannelId,
        nowPlayingMessageId,
        lyricsMessageId: null,
        queueMessageId,
      })),
      save: vi.fn(),
    } as unknown as ControlPanelStateStore;
    const playerGateway = {
      // A track must actually be playing for a lyrics message to get
      // created at all (see ensureLyricsMessage) — an idle snapshot would
      // mean nothing to send.
      getSnapshot: vi.fn(() => ({
        currentTrack: { title: "Track", author: "Artist", uri: "https://example.com/track", durationMs: 200_000, positionMs: 0, isStream: false },
        paused: false,
        upcomingLyricLines: [],
      })),
      reconcileVoiceState: vi.fn(() => Promise.resolve(false)),
      getQueue: vi.fn(() => []),
    } as unknown as MusicPlayerGateway;
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const eventBus = { subscribe: vi.fn((): (() => void) => () => undefined) } as unknown as MusicEventBus;

    const service = new ControlChannelService(
      client as never,
      configuration,
      provider,
      stateStore,
      playerGateway,
      {} as unknown as PlaybackService,
      { getYohtaTheme: () => null, hasEmoji: () => false, getEmojiTag: () => null } as never,
      logger as never,
      eventBus,
    );

    await (
      service as unknown as { writeTimedPanels: (guildId: string) => Promise<void> }
    ).writeTimedPanels(guildId);

    expect(nowPlayingMessage.edit).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(sentLyricsMessage.edit).not.toHaveBeenCalled();
    expect(queueMessage.edit).not.toHaveBeenCalled();
  });

  it("throttles Now Playing edits on a longer interval than lyrics edits, on consecutive timed ticks", async () => {
    // Now Playing and Lyrics have separate throttle floors, and — since a
    // real production 429 storm proved event-driven writes need the same
    // protection as timed ticks — those floors now live inside
    // writeNowPlayingMessage/writeLyricsMessage themselves (see the comments
    // there), not in a caller-side conditional. So this exercises the real
    // methods against real message mocks instead of mocking them away,
    // varying playback position each tick so a skip can only be the floor,
    // never matchesCurrentMessage finding nothing changed.
    vi.useFakeTimers();
    function messageMock(): { edit: ReturnType<typeof vi.fn>; attachments: { size: number; some: () => boolean } } {
      return { edit: vi.fn().mockResolvedValue(undefined), attachments: { size: 0, some: (): boolean => false } };
    }
    const nowPlayingMessage = messageMock();
    const lyricsMessage = messageMock();
    // ensureLyricsMessage sends a fresh message the first time a track is
    // seen, then reuses (edits) that same message for as long as the track
    // stays the same — this mock's channel.send always returns the one
    // lyricsMessage, since every call below keeps the same track title.
    const channel = { send: vi.fn().mockResolvedValue(lyricsMessage) };
    const { service, getSnapshot } = createService(false);
    const internals = service as unknown as {
      ensurePanelMessages: () => Promise<unknown>;
      writeTimedPanels: (id: string) => Promise<void>;
      resetProgressRefreshTimer: (id: string, snapshot: unknown) => void;
    };
    let positionMs = 0;
    getSnapshot.mockImplementation(() => ({
      currentTrack: { title: "Track", author: "Artist", uri: "https://example.com", durationMs: 240_000, positionMs, isStream: false },
      paused: false,
      currentLyricLine: `Line at ${positionMs}`,
      upcomingLyricLines: [],
    }));
    vi.spyOn(internals, "ensurePanelMessages").mockResolvedValue({ channel, nowPlaying: nowPlayingMessage, queue: {} });
    // This test drives writeTimedPanels explicitly to control exact timing;
    // the real internal timer chain it would otherwise (re)arm must not also
    // fire calls of its own in the background while fake time is advanced.
    vi.spyOn(internals, "resetProgressRefreshTimer").mockImplementation(() => undefined);

    // First cycle: Now Playing edits (nothing edited yet, floor is wide
    // open). Lyrics is brand new for this guild — ensureLyricsMessage sends
    // it fresh with the current content already in the send payload, so
    // there's nothing left to edit this cycle.
    await internals.writeTimedPanels(guildId);
    expect(nowPlayingMessage.edit).toHaveBeenCalledOnce();
    expect(channel.send).toHaveBeenCalledOnce();
    expect(lyricsMessage.edit).not.toHaveBeenCalled();

    // 4s later: past the 3s lyrics floor (measured from the last *edit*,
    // and there hasn't been one yet), but short of the 5s Now Playing floor
    // — Now Playing must not have been written again, lyrics must.
    positionMs = 4_000;
    await vi.advanceTimersByTimeAsync(4_000);
    await internals.writeTimedPanels(guildId);
    expect(nowPlayingMessage.edit).toHaveBeenCalledOnce();
    expect(lyricsMessage.edit).toHaveBeenCalledOnce();

    // 2.5s after that (6.5s total): past the 5s Now Playing floor (last
    // edited at t=0) — due again. Short of the 3s lyrics floor (last
    // edited at t=4s, only 2.5s ago) — must not have been written again.
    positionMs = 6_500;
    await vi.advanceTimersByTimeAsync(2_500);
    await internals.writeTimedPanels(guildId);
    expect(nowPlayingMessage.edit).toHaveBeenCalledTimes(2);
    expect(lyricsMessage.edit).toHaveBeenCalledOnce();
    service.stop();
  });

  it("writeTimedPanels doesn't reject when reconciling voice state fails, so the timer callback can't crash the process", async () => {
    // Regression: writeTimedPanels runs detached from a `setTimeout` callback
    // (`void this.writeTimedPanels(guildId)`) — nothing awaits it or catches
    // a rejection, so an uncaught error here used to become an unhandled
    // promise rejection, which terminates the process under Node's default
    // unhandled-rejection behavior. A single transient failure must not take
    // the whole bot down.
    const client = { user: { id: botUserId }, guilds: { cache: new Map() } };
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
      find: vi.fn(() => null),
      save: vi.fn(),
    } as unknown as ControlPanelStateStore;
    const playerGateway = {
      getSnapshot: vi.fn(() => null),
      reconcileVoiceState: vi.fn(() => Promise.reject(new Error("voice state lookup failed"))),
      getQueue: vi.fn(() => []),
    } as unknown as MusicPlayerGateway;
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const eventBus = { subscribe: vi.fn((): (() => void) => () => undefined) } as unknown as MusicEventBus;

    const service = new ControlChannelService(
      client as never,
      configuration,
      provider,
      stateStore,
      playerGateway,
      {} as unknown as PlaybackService,
      { getYohtaTheme: () => null, hasEmoji: () => false, getEmojiTag: () => null } as never,
      logger as never,
      eventBus,
    );

    await expect(
      (service as unknown as { writeTimedPanels: (guildId: string) => Promise<void> }).writeTimedPanels(guildId),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ guildId }),
      "Unable to reconcile voice state during a timed panel refresh",
    );
  });

  it("doesn't delete and recreate the panel trio over a transient message-fetch error", async () => {
    // Regression: fetchExistingTrio used to treat *any* fetch failure the
    // same as "the message is really gone" and delete + recreate all three
    // panel messages over it — including a transient 500/503 that would have
    // resolved on its own by the next refresh. Only an actual "Unknown
    // Message" (10008) should be treated as missing.
    const nowPlayingMessageId = "777777777777777777";
    const lyricsMessageId = "888888888888888888";
    const queueMessageId = "999999999999999999";

    function messageMock(): {
      id: string; author: { id: string }; attachments: { size: number; some: () => boolean };
      content: string; embeds: unknown[]; components: unknown[];
      edit: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn>;
    } {
      return {
        id: "",
        author: { id: botUserId },
        attachments: { size: 0, some: (): boolean => false },
        content: "",
        embeds: [],
        components: [],
        edit: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      };
    }
    const nowPlayingMessage = { ...messageMock(), id: nowPlayingMessageId };
    const lyricsMessage = { ...messageMock(), id: lyricsMessageId };
    const transientError = new DiscordAPIError(
      { message: "Internal Server Error", code: 0 },
      0,
      500,
      "GET",
      "/channels/x/messages/y",
      { body: undefined, files: undefined },
    );

    const channel = {
      id: controlPanelChannelId,
      type: ChannelType.GuildText,
      permissionOverwrites: { edit: vi.fn().mockResolvedValue(undefined) },
      messages: {
        fetch: vi.fn((id: string) => {
          if (id === nowPlayingMessageId) return Promise.resolve(nowPlayingMessage);
          if (id === lyricsMessageId) return Promise.resolve(lyricsMessage);
          if (id === queueMessageId) return Promise.reject(transientError);
          return Promise.resolve(null);
        }),
      },
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
      find: vi.fn(() => ({
        guildId,
        channelId: controlPanelChannelId,
        nowPlayingMessageId,
        lyricsMessageId,
        queueMessageId,
      })),
      save: vi.fn(),
    } as unknown as ControlPanelStateStore;
    const playerGateway = {
      getSnapshot: vi.fn(() => null),
      reconcileVoiceState: vi.fn(() => Promise.resolve(false)),
      getQueue: vi.fn(() => []),
    } as unknown as MusicPlayerGateway;
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const eventBus = { subscribe: vi.fn((): (() => void) => () => undefined) } as unknown as MusicEventBus;

    const service = new ControlChannelService(
      client as never,
      configuration,
      provider,
      stateStore,
      playerGateway,
      {} as unknown as PlaybackService,
      { getYohtaTheme: () => null, hasEmoji: () => false, getEmojiTag: () => null } as never,
      logger as never,
      eventBus,
    );

    await (
      service as unknown as { writeTimedPanels: (guildId: string) => Promise<void> }
    ).writeTimedPanels(guildId);

    expect(nowPlayingMessage.delete).not.toHaveBeenCalled();
    expect(lyricsMessage.delete).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: transientError, guildId }),
      "Unable to ensure music control panel messages",
    );
  });

  it("treats an actual Unknown Message error as missing (rebuilds the trio)", async () => {
    const nowPlayingMessageId = "777777777777777777";
    const lyricsMessageId = "888888888888888888";
    const queueMessageId = "999999999999999999";
    const unknownMessageError = new DiscordAPIError(
      { message: "Unknown Message", code: RESTJSONErrorCodes.UnknownMessage },
      RESTJSONErrorCodes.UnknownMessage,
      404,
      "GET",
      "/channels/x/messages/y",
      { body: undefined, files: undefined },
    );

    function sentMessage(): {
      id: string; author: { id: string }; attachments: { size: number; some: () => boolean };
      content: string; embeds: unknown[]; components: unknown[];
      edit: ReturnType<typeof vi.fn>; pinned: boolean; pin: ReturnType<typeof vi.fn>;
    } {
      return {
        id: "new-message-id",
        author: { id: botUserId },
        attachments: { size: 0, some: (): boolean => false },
        content: "",
        embeds: [],
        components: [],
        edit: vi.fn().mockResolvedValue(undefined),
        pinned: false,
        pin: vi.fn().mockResolvedValue(undefined),
      };
    }
    const channel = {
      id: controlPanelChannelId,
      type: ChannelType.GuildText,
      permissionOverwrites: { edit: vi.fn().mockResolvedValue(undefined) },
      messages: {
        fetch: vi.fn((id: string) => (
          id === queueMessageId ? Promise.reject(unknownMessageError) : Promise.resolve(null)
        )),
      },
      send: vi.fn(() => Promise.resolve(sentMessage())),
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
      find: vi.fn(() => ({
        guildId,
        channelId: controlPanelChannelId,
        nowPlayingMessageId,
        lyricsMessageId,
        queueMessageId,
      })),
      save: vi.fn().mockResolvedValue(undefined),
    } as unknown as ControlPanelStateStore;
    const playerGateway = {
      getSnapshot: vi.fn(() => null),
      reconcileVoiceState: vi.fn(() => Promise.resolve(false)),
      getQueue: vi.fn(() => []),
    } as unknown as MusicPlayerGateway;
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
    const eventBus = { subscribe: vi.fn((): (() => void) => () => undefined) } as unknown as MusicEventBus;

    const service = new ControlChannelService(
      client as never,
      configuration,
      provider,
      stateStore,
      playerGateway,
      {} as unknown as PlaybackService,
      { getYohtaTheme: () => null, hasEmoji: () => false, getEmojiTag: () => null } as never,
      logger as never,
      eventBus,
    );

    await (
      service as unknown as { writeTimedPanels: (guildId: string) => Promise<void> }
    ).writeTimedPanels(guildId);

    // With one message genuinely missing, the whole trio is rebuilt from
    // scratch rather than partially patched.
    expect(channel.send).toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  describe("matchesCurrentMessage", () => {
    function matches(
      service: ControlChannelService,
      message: unknown,
      editOptions: unknown,
    ): boolean {
      return (
        service as unknown as {
          matchesCurrentMessage: (message: unknown, editOptions: unknown) => boolean;
        }
      ).matchesCurrentMessage(message, editOptions);
    }

    function baseMessage(): { content: string; embeds: unknown[]; components: unknown[]; attachments: { size: number } } {
      return {
        content: "panel content",
        embeds: [{ toJSON: () => ({ title: "Now Playing" }) }],
        components: [{ toJSON: () => ({ custom_id: "pause" }) }],
        attachments: { size: 0 },
      };
    }

    function baseEditOptions(): { content: string; embeds: unknown[]; components: unknown[] } {
      return {
        content: "panel content",
        embeds: [{ toJSON: () => ({ title: "Now Playing" }) }],
        components: [{ toJSON: () => ({ custom_id: "pause" }) }],
      };
    }

    it("skips when content, embed, and components are all identical", () => {
      const { service } = createService(false);
      expect(matches(service, baseMessage(), baseEditOptions())).toBe(true);
    });

    it("skips when the embed is unchanged even though Discord's fetched message carries extra server-added fields", () => {
      // Regression: a message fetched back from Discord's API includes
      // fields we never set ourselves (type: "rich", and width/height/
      // proxy_url on images) — comparing the full JSON directly against our
      // own freshly-built embed would never match, forcing a real edit (and
      // its rate-limit cost) on every single refresh even when nothing
      // actually changed.
      const { service } = createService(false);
      const message = baseMessage();
      message.embeds = [{
        toJSON: (): Record<string, unknown> => ({
          type: "rich",
          title: "Now Playing",
          description: "Counting Stars",
          color: 123,
          image: { url: "https://cdn.example/art.png", width: 640, height: 640, proxy_url: "https://media.example/art.png" },
        }),
      }];
      const editOptions = baseEditOptions();
      editOptions.embeds = [{
        toJSON: (): Record<string, unknown> => ({
          title: "Now Playing",
          description: "Counting Stars",
          color: 123,
          image: { url: "https://cdn.example/art.png" },
        }),
      }];
      expect(matches(service, message, editOptions)).toBe(true);
    });

    it("does not skip when the embed differs", () => {
      const { service } = createService(false);
      const editOptions = baseEditOptions();
      editOptions.embeds = [{ toJSON: (): { title: string } => ({ title: "Playback paused" }) }];
      expect(matches(service, baseMessage(), editOptions)).toBe(false);
    });

    it("does not skip when the components differ (e.g. a button's disabled state changed)", () => {
      const { service } = createService(false);
      const editOptions = baseEditOptions();
      editOptions.components = [
        { toJSON: (): { custom_id: string; disabled: boolean } => ({ custom_id: "pause", disabled: true }) },
      ];
      expect(matches(service, baseMessage(), editOptions)).toBe(false);
    });

    it("does not skip when content differs", () => {
      const { service } = createService(false);
      const editOptions = { ...baseEditOptions(), content: "different content" };
      expect(matches(service, baseMessage(), editOptions)).toBe(false);
    });

    it("does not skip when a new attachment file is being uploaded", () => {
      const { service } = createService(false);
      const editOptions = { ...baseEditOptions(), files: [{ attachment: "path", name: "idle.png" }] };
      expect(matches(service, baseMessage(), editOptions)).toBe(false);
    });

    it("skips a redundant attachments: [] when the message already has no attachments", () => {
      const { service } = createService(false);
      const editOptions = { ...baseEditOptions(), attachments: [] as const };
      expect(matches(service, baseMessage(), editOptions)).toBe(true);
    });

    it("does not skip attachments: [] when the message actually has an attachment to clear", () => {
      const { service } = createService(false);
      const message = { ...baseMessage(), attachments: { size: 1 } };
      const editOptions = { ...baseEditOptions(), attachments: [] as const };
      expect(matches(service, message, editOptions)).toBe(false);
    });
  });
});
