import { ChannelType, type Client } from "discord.js";
import {
  LavalinkManager,
  type Player,
  type SearchResult,
  type Track,
  type UnresolvedSearchResult,
  type UnresolvedTrack,
  type VoicePacket,
  type VoiceServer,
  type VoiceState,
  type ChannelDeletePacket,
} from "lavalink-client";
import type { Logger } from "pino";

import {
  MusicPlayerNotFoundError,
  MusicSearchEmptyError,
} from "../../application/music/music-errors.js";
import type {
  EnqueueRequest,
  MusicFilterPreset,
  MusicRepeatMode,
  MusicPlayerGateway,
} from "../../application/music/music-player-gateway.js";
import type { LavalinkConfiguration } from "../../config/configuration.js";
import type { EnqueueResult, MusicTrack, PlayHistoryEntry } from "../../domain/music/music-track.js";
import type { MusicPlayerSnapshot } from "../../application/music/music-player-gateway.js";
import type { MusicEventBus, MusicStateChangedEvent } from "../../application/music/music-event-bus.js";
import type { GuildConfigurationProvider } from "../../config/guild-configuration-provider.js";
import { LavalinkAutoQueue, type AutoQueueOutcome } from "./lavalink-auto-queue.js";

const playHistoryLimit = 20;

export class LavalinkPlayerGateway implements MusicPlayerGateway {
  private readonly manager: LavalinkManager;
  private readonly autoQueue = new LavalinkAutoQueue();
  private readonly emptyQueueTimers = new Map<string, NodeJS.Timeout>();
  private readonly emptyChannelTimers = new Map<string, NodeJS.Timeout>();
  private readonly autoQueueIssues = new Set<string>();
  private readonly playHistoryByGuild = new Map<string, PlayHistoryEntry[]>();

  public constructor(
    private readonly client: Client,
    configuration: LavalinkConfiguration,
    private readonly logger: Logger,
    private readonly eventBus: MusicEventBus,
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
  ) {
    this.manager = new LavalinkManager({
      nodes: [
        {
          id: "primary",
          host: configuration.host,
          port: configuration.port,
          authorization: configuration.password,
          secure: configuration.secure,
        },
      ],
      sendToShard: (guildId, payload): void => {
        client.guilds.cache.get(guildId)?.shard.send(payload);
      },
      autoSkip: true,
      autoMove: true,
      autoSkipOnResolveError: true,
      playerOptions: {
        defaultSearchPlatform: "spsearch",
        clientBasedPositionUpdateInterval: 1_000,
        onDisconnect: {
          autoReconnect: false,
          destroyPlayer: true,
        },
        onEmptyQueue: {
          autoPlayFunction: async (player, lastTrack): Promise<void> => {
            if (!player.get<boolean>("autoQueue")) return;
            const outcome = await this.autoQueue.enqueueNext(player, lastTrack);
            this.logAutoQueueOutcome(player, lastTrack, outcome);
          },
        },
      },
      queueOptions: {
        maxPreviousTracks: 25,
      },
    });

    this.manager.nodeManager.on("connect", (node) => {
      logger.info({ nodeId: node.id }, "Lavalink node connected");
    });

    this.manager.nodeManager.on("disconnect", (node, reason) => {
      logger.warn({ nodeId: node.id, reason }, "Lavalink node disconnected");
    });

    this.manager.nodeManager.on("error", (node, error) => {
      logger.error({ nodeId: node.id, error }, "Lavalink node error");
    });

    this.manager.on("trackError", (player, track, payload) => {
      logger.error(
        {
          guildId: player.guildId,
          trackTitle: track?.info.title,
          exception: payload.exception,
        },
        "Lavalink track exception",
      );
    });

    this.manager.on("trackStart", (player, track) => {
      this.clearTimer(this.emptyQueueTimers, player.guildId);
      this.autoQueueIssues.delete(player.guildId);
      if (track) this.recordPlayHistory(player.guildId, track);
      this.publishStateChange({ guildId: player.guildId, reason: "track_started" });
    });

    this.manager.on("queueEnd", (player) => {
      this.publishStateChange({ guildId: player.guildId, reason: "queue_changed" });
      this.scheduleEmptyQueueAction(player.guildId);
    });

    this.manager.on("playerDestroy", (player) => {
      this.clearTimer(this.emptyQueueTimers, player.guildId);
      this.clearTimer(this.emptyChannelTimers, player.guildId);
      this.autoQueue.clear(player.guildId);
      this.autoQueueIssues.delete(player.guildId);
      this.publishStateChange({ guildId: player.guildId, reason: "player_destroyed" });
    });
  }

  public async initialize(clientUser: { id: string; username: string }): Promise<void> {
    await this.manager.init(clientUser);
  }

  public acceptDiscordGatewayPayload(payload: unknown): void {
    if (this.manager.initiated) {
      void this.manager.sendRawData(
        payload as VoicePacket | VoiceServer | VoiceState | ChannelDeletePacket,
      );
    }
  }

  public async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
    const existingPlayer = this.manager.getPlayer(request.guildId);
    const player = this.manager.createPlayer({
      guildId: request.guildId,
      voiceChannelId: request.voiceChannelId,
      textChannelId: request.textChannelId,
      selfDeaf: true,
    });

    await player.connect();
    await this.prepareStageChannel(request.guildId);
    if (!existingPlayer) {
      const profile = this.guildConfigurationProvider.find(request.guildId);
      if (profile) await player.setVolume(profile.music.defaultVolume);
    }

    const searchResult = await this.searchWithFallback(player, request.query, {
      userId: request.requestedByUserId,
    });
    const tracks = searchResult.tracks;

    if (tracks.length === 0) {
      if (!player.queue.current) {
        await player.destroy("Search returned no playable tracks");
      }
      throw new MusicSearchEmptyError();
    }

    const selectedTracks = searchResult.loadType === "playlist"
      ? tracks
      : [tracks[0] as Track | UnresolvedTrack];
    const firstTrack = selectedTracks[0];

    if (!firstTrack) {
      throw new MusicSearchEmptyError();
    }

    for (const track of selectedTracks) {
      track.userData = {
        ...track.userData,
        requestedByUserId: request.requestedByUserId,
      };
    }

    await player.queue.add(selectedTracks);

    const startedPlayback = !player.playing && !player.paused;
    const queuePosition = startedPlayback
      ? null
      : Math.max(1, player.queue.tracks.length - selectedTracks.length + 1);
    if (startedPlayback) {
      await player.play();
    }

    this.publishStateChange({ guildId: request.guildId, reason: "queue_changed" });

    return {
      firstTrack: this.toMusicTrack(firstTrack, request.requestedByUserId),
      addedTrackCount: selectedTracks.length,
      startedPlayback,
      queuePosition,
    };
  }

  private async searchWithFallback(
    player: Player,
    query: string,
    requester: { userId: string },
  ): Promise<SearchResult | UnresolvedSearchResult> {
    try {
      const primary = await player.search({ query, source: "spsearch" }, requester);
      if (primary.tracks.length > 0) return primary;
    } catch (error) {
      this.logger.warn({ error, query }, "Spotify search failed, falling back to YouTube");
    }

    return player.search({ query, source: "ytsearch" }, requester);
  }

  public async pause(guildId: string): Promise<void> {
    await this.requirePlayer(guildId).pause();
    this.publishStateChange({ guildId, reason: "paused" });
  }

  public async resume(guildId: string): Promise<void> {
    await this.requirePlayer(guildId).resume();
    this.publishStateChange({ guildId, reason: "resumed" });
  }

  public async stop(guildId: string): Promise<void> {
    await this.requirePlayer(guildId).destroy("Stopped by a user");
    this.publishStateChange({ guildId, reason: "stopped" });
  }

  public async skip(guildId: string): Promise<void> {
    const player = this.requirePlayer(guildId);
    const currentTrack = player.queue.current;
    if (
      currentTrack &&
      player.get<boolean>("autoQueue") &&
      player.queue.tracks.length === 0
    ) {
      const outcome = await this.autoQueue.enqueueNext(player, currentTrack);
      this.logAutoQueueOutcome(player, currentTrack, outcome);
    }
    await player.skip();
    this.publishStateChange({ guildId, reason: "queue_changed" });
  }

  public async skipTo(guildId: string, position: number): Promise<MusicTrack> {
    const player = this.requirePlayer(guildId);
    const index = position - 1;
    const track = player.queue.tracks[index];
    if (!track) throw new MusicSearchEmptyError();
    await player.skip(index, true);
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return this.toMusicTrack(
      track,
      typeof track.userData?.requestedByUserId === "string"
        ? track.userData.requestedByUserId
        : "unknown",
    );
  }

  private logAutoQueueOutcome(
    player: Player,
    sourceTrack: Track | UnresolvedTrack,
    outcome: AutoQueueOutcome,
  ): void {
    if (outcome.status === "queued") {
      this.autoQueueIssues.delete(player.guildId);
      return;
    }
    this.autoQueueIssues.add(player.guildId);
    this.logger.warn(
      {
        guildId: player.guildId,
        trackTitle: sourceTrack.info.title,
        error: outcome.status === "failed" ? outcome.error : undefined,
      },
      outcome.status === "failed"
        ? "Autoqueue recommendation lookup failed"
        : "Autoqueue found no unplayed recommendation",
    );
  }

  public async previous(guildId: string): Promise<void> {
    const player = this.requirePlayer(guildId);
    const previousTrack = await player.queue.shiftPrevious();
    if (!previousTrack) throw new MusicPlayerNotFoundError();
    await player.play({ clientTrack: previousTrack });
    this.publishStateChange({ guildId, reason: "queue_changed" });
  }

  public async changeVolume(
    guildId: string,
    delta: number,
    maximum: number,
  ): Promise<void> {
    const player = this.requirePlayer(guildId);
    await player.setVolume(Math.max(0, Math.min(maximum, player.volume + delta)));
    this.publishStateChange({ guildId, reason: "volume_changed" });
  }

  public async setVolume(guildId: string, volume: number, maximum: number): Promise<void> {
    await this.requirePlayer(guildId).setVolume(Math.max(0, Math.min(maximum, volume)));
    this.publishStateChange({ guildId, reason: "volume_changed" });
  }

  public async shuffle(guildId: string): Promise<void> {
    const player = this.requirePlayer(guildId);
    await player.queue.shuffle();
    this.publishStateChange({ guildId, reason: "queue_changed" });
  }

  public getQueue(guildId: string): readonly MusicTrack[] {
    const player = this.requirePlayer(guildId);
    return player.queue.tracks.map((track) => this.toMusicTrack(
      track,
      typeof track.userData?.requestedByUserId === "string"
        ? track.userData.requestedByUserId
        : "unknown",
    ));
  }

  public getPlayHistory(guildId: string): readonly PlayHistoryEntry[] {
    return this.playHistoryByGuild.get(guildId) ?? [];
  }

  private recordPlayHistory(guildId: string, track: Track | UnresolvedTrack): void {
    const entry: PlayHistoryEntry = {
      ...this.toMusicTrack(
        track,
        typeof track.userData?.requestedByUserId === "string"
          ? track.userData.requestedByUserId
          : "unknown",
      ),
      playedAt: Date.now(),
    };
    const history = [entry, ...(this.playHistoryByGuild.get(guildId) ?? [])].slice(0, playHistoryLimit);
    this.playHistoryByGuild.set(guildId, history);
  }

  public async removeQueueTrack(guildId: string, position: number): Promise<MusicTrack> {
    const player = this.requirePlayer(guildId);
    const index = position - 1;
    const track = player.queue.tracks[index];
    if (!track) throw new MusicSearchEmptyError();
    await player.queue.remove(index);
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return this.toMusicTrack(
      track,
      typeof track.userData?.requestedByUserId === "string"
        ? track.userData.requestedByUserId
        : "unknown",
    );
  }

  public async moveQueueTrack(guildId: string, from: number, to: number): Promise<MusicTrack> {
    const player = this.requirePlayer(guildId);
    const fromIndex = from - 1;
    const track = player.queue.tracks[fromIndex];
    if (!track) throw new MusicSearchEmptyError();
    const toIndex = Math.max(0, Math.min(to - 1, player.queue.tracks.length - 1));
    await player.queue.splice(fromIndex, 1);
    await player.queue.add(track, toIndex);
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return this.toMusicTrack(
      track,
      typeof track.userData?.requestedByUserId === "string"
        ? track.userData.requestedByUserId
        : "unknown",
    );
  }

  public async seek(guildId: string, positionMs: number): Promise<MusicTrack> {
    const player = this.requirePlayer(guildId);
    const currentTrack = player.queue.current;
    if (!currentTrack) throw new MusicPlayerNotFoundError();
    const durationMs = currentTrack.info.duration;
    await player.seek(Math.max(0, Math.min(positionMs, durationMs)));
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return this.toMusicTrack(
      currentTrack,
      typeof currentTrack.userData?.requestedByUserId === "string"
        ? currentTrack.userData.requestedByUserId
        : "unknown",
    );
  }

  public async replay(guildId: string): Promise<MusicTrack> {
    const player = this.requirePlayer(guildId);
    const currentTrack = player.queue.current;
    if (!currentTrack) throw new MusicPlayerNotFoundError();
    await player.seek(0);
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return this.toMusicTrack(
      currentTrack,
      typeof currentTrack.userData?.requestedByUserId === "string"
        ? currentTrack.userData.requestedByUserId
        : "unknown",
    );
  }

  public async clearQueue(guildId: string): Promise<number> {
    const player = this.requirePlayer(guildId);
    const count = player.queue.tracks.length;
    if (count > 0) await player.queue.remove(player.queue.tracks.slice());
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return count;
  }

  public async setRepeatMode(guildId: string, mode: MusicRepeatMode): Promise<void> {
    await this.requirePlayer(guildId).setRepeatMode(mode);
    this.publishStateChange({ guildId, reason: "queue_changed" });
  }

  public async setFilterPreset(guildId: string, preset: MusicFilterPreset): Promise<void> {
    const player = this.requirePlayer(guildId);
    await player.filterManager.resetFilters();
    switch (preset) {
      case "off":
        break;
      case "nightcore":
        await player.filterManager.toggleNightcore();
        break;
      case "vaporwave":
        await player.filterManager.toggleVaporwave();
        break;
      case "bassboost":
        await player.filterManager.setEQPreset("BassboostMedium");
        break;
      case "pop":
        await player.filterManager.setEQPreset("Pop");
        break;
      case "eightD":
        await player.filterManager.toggleRotation();
        break;
      case "karaoke":
        await player.filterManager.toggleKaraoke();
        break;
      case "vibrato":
        await player.filterManager.toggleVibrato();
        break;
      case "tremolo":
        await player.filterManager.toggleTremolo();
        break;
    }
    this.publishStateChange({ guildId, reason: "queue_changed" });
  }

  public toggleAutoQueue(guildId: string): Promise<boolean> {
    const player = this.requirePlayer(guildId);
    const enabled = !player.get<boolean>("autoQueue");
    player.set("autoQueue", enabled);
    if (!enabled) this.autoQueue.clear(guildId);
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return Promise.resolve(enabled);
  }

  public toggleTwentyFourSeven(guildId: string): Promise<boolean> {
    const player = this.requirePlayer(guildId);
    const enabled = !player.get<boolean>("twentyFourSeven");
    player.set("twentyFourSeven", enabled);
    if (enabled) this.clearTimer(this.emptyQueueTimers, guildId);
    else if (!player.queue.current && player.queue.tracks.length === 0) {
      this.scheduleEmptyQueueAction(guildId);
    }
    this.publishStateChange({ guildId, reason: "queue_changed" });
    return Promise.resolve(enabled);
  }

  public async handleBotVoiceDisconnect(guildId: string): Promise<void> {
    const player = this.manager.getPlayer(guildId);
    if (!player) return;
    this.clearTimer(this.emptyQueueTimers, guildId);
    this.clearTimer(this.emptyChannelTimers, guildId);
    await player.destroy("Bot was disconnected or moved from its voice channel");
  }

  // Called when the bot leaves a guild, so per-guild timers/caches don't grow
  // unbounded across many join/leave cycles.
  public async handleGuildRemoved(guildId: string): Promise<void> {
    this.clearTimer(this.emptyQueueTimers, guildId);
    this.clearTimer(this.emptyChannelTimers, guildId);
    this.autoQueueIssues.delete(guildId);
    this.autoQueue.clear(guildId);
    this.playHistoryByGuild.delete(guildId);
    const player = this.manager.getPlayer(guildId);
    if (player) await player.destroy("Bot was removed from the guild");
  }

  public handleVoiceChannelOccupancy(guildId: string, humanMemberCount: number): void {
    const player = this.manager.getPlayer(guildId);
    if (!player) return;
    const profile = this.guildConfigurationProvider.find(guildId);
    if (!profile) return;

    if (humanMemberCount > 0) {
      this.clearTimer(this.emptyChannelTimers, guildId);
      if (profile.music.resumeWhenOccupied && player.get<boolean>("autoPaused")) {
        player.set("autoPaused", false);
        void player.resume();
      }
      return;
    }

    if (player.get<boolean>("twentyFourSeven") || profile.music.emptyChannelAction === "continue") return;
    this.clearTimer(this.emptyChannelTimers, guildId);
    const timer = setTimeout(() => {
      if (profile.music.emptyChannelAction === "pause") {
        player.set("autoPaused", true);
        void player.pause();
      } else {
        void player.destroy("Voice channel became empty");
      }
    }, profile.music.emptyChannelGracePeriodMs);
    timer.unref();
    this.emptyChannelTimers.set(guildId, timer);
  }

  public hasPlayer(guildId: string): boolean {
    return Boolean(this.manager.getPlayer(guildId));
  }

  public isPaused(guildId: string): boolean {
    return this.requirePlayer(guildId).paused;
  }

  public getVoiceChannelId(guildId: string): string | null {
    return this.manager.getPlayer(guildId)?.voiceChannelId ?? null;
  }

  public getSnapshot(guildId: string): MusicPlayerSnapshot | null {
    const player = this.manager.getPlayer(guildId);
    if (!player) return null;

    const current = player.queue.current;
    const requestedByUserId = current?.userData?.requestedByUserId;

    return {
      guildId,
      voiceChannelId: player.voiceChannelId ?? "",
      paused: player.paused,
      playing: player.playing,
      volume: player.volume,
      queueLength: player.queue.tracks.length,
      previousTrackCount: player.queue.previous.length,
      repeatMode: player.repeatMode,
      autoQueue: player.get<boolean>("autoQueue") ?? false,
      autoQueueIssue: this.autoQueueIssues.has(guildId),
      twentyFourSeven: player.get<boolean>("twentyFourSeven") ?? false,
      currentTrack: current
        ? {
            title: current.info.title,
            author: current.info.author ?? "Unknown artist",
            uri: current.info.uri ?? "",
            artworkUrl: current.info.artworkUrl ?? null,
            durationMs: current.info.duration ?? 0,
            positionMs: player.position,
            isStream: current.info.isStream ?? false,
            requestedByUserId:
              typeof requestedByUserId === "string" ? requestedByUserId : null,
          }
        : null,
    };
  }

  private requirePlayer(guildId: string): Player {
    const player = this.manager.getPlayer(guildId);
    if (!player) {
      throw new MusicPlayerNotFoundError();
    }

    return player;
  }

  private toMusicTrack(
    track: Track | UnresolvedTrack,
    requestedByUserId: string,
  ): MusicTrack {
    return {
      identifier: track.info.identifier ?? track.info.uri ?? track.info.title,
      title: track.info.title,
      author: track.info.author ?? "Unknown artist",
      uri: track.info.uri ?? "",
      artworkUrl: track.info.artworkUrl ?? null,
      durationMs: track.info.duration ?? 0,
      isStream: track.info.isStream ?? false,
      requestedByUserId,
    };
  }

  private publishStateChange(event: MusicStateChangedEvent): void {
    void this.eventBus.publish(event).catch((error: unknown) => {
      this.logger.error({ error, event }, "Music state listener failed");
    });
  }

  private scheduleEmptyQueueAction(guildId: string): void {
    const player = this.manager.getPlayer(guildId);
    const profile = this.guildConfigurationProvider.find(guildId);
    if (
      !player ||
      !profile ||
      player.queue.current ||
      player.queue.tracks.length > 0 ||
      player.get<boolean>("twentyFourSeven")
    ) return;
    if (profile.music.emptyQueueAction === "stay_connected") return;
    this.clearTimer(this.emptyQueueTimers, guildId);
    const timer = setTimeout(() => {
      void this.manager.getPlayer(guildId)?.destroy("Queue remained empty");
    }, profile.music.emptyQueueDelayMs);
    timer.unref();
    this.emptyQueueTimers.set(guildId, timer);
  }

  private clearTimer(timers: Map<string, NodeJS.Timeout>, guildId: string): void {
    const timer = timers.get(guildId);
    if (timer) clearTimeout(timer);
    timers.delete(guildId);
  }

  private async prepareStageChannel(guildId: string): Promise<void> {
    const botVoiceState = this.client.guilds.cache.get(guildId)?.members.me?.voice;
    if (botVoiceState?.channel?.type !== ChannelType.GuildStageVoice) return;
    await botVoiceState.setRequestToSpeak(true).catch((error: unknown) => {
      this.logger.warn({ error, guildId }, "Unable to request speaker status in Stage channel");
    });
    await botVoiceState.setSuppressed(false).catch((error: unknown) => {
      this.logger.warn({ error, guildId }, "Unable to unsuppress bot in Stage channel");
    });
  }
}
