import type { GuildMember } from "discord.js";

import {
  MusicPlayerNotFoundError,
  MusicRateLimitError,
  MusicVoiceChannelMismatchError,
  MusicVoiceChannelRequiredError,
} from "./music-errors.js";
import { PlaybackRateLimiter } from "./playback-rate-limiter.js";
import type {
  EnqueueRequest,
  MusicRepeatMode,
  MusicPlayerGateway,
} from "./music-player-gateway.js";
import type { EnqueueResult } from "../../domain/music/music-track.js";

export interface PlaybackActor {
  guildId: string;
  textChannelId: string;
  userId: string;
  member: GuildMember;
}

export class PlaybackService {
  private readonly rateLimiter = new PlaybackRateLimiter();

  public constructor(private readonly playerGateway: MusicPlayerGateway) {}

  public async enqueue(actor: PlaybackActor, query: string): Promise<EnqueueResult> {
    const remainingSeconds = this.rateLimiter.check(actor.guildId, actor.userId);
    if (remainingSeconds !== null) {
      throw new MusicRateLimitError(remainingSeconds);
    }

    const voiceChannelId = this.requireVoiceChannel(actor);
    this.assertSameVoiceChannel(actor.guildId, voiceChannelId);

    const request: EnqueueRequest = {
      guildId: actor.guildId,
      voiceChannelId,
      textChannelId: actor.textChannelId,
      query,
      requestedByUserId: actor.userId,
    };

    // Recorded before the search so failed lookups are rate limited too; the
    // gateway performs a Lavalink search before it can reject a bad query.
    this.rateLimiter.record(actor.guildId, actor.userId);
    return this.playerGateway.enqueue(request);
  }

  public async pause(actor: PlaybackActor): Promise<void> {
    this.assertControllablePlayer(actor);
    await this.playerGateway.pause(actor.guildId);
  }

  public async resume(actor: PlaybackActor): Promise<void> {
    this.assertControllablePlayer(actor);
    await this.playerGateway.resume(actor.guildId);
  }

  public async stop(actor: PlaybackActor): Promise<void> {
    this.assertControllablePlayer(actor);
    await this.playerGateway.stop(actor.guildId);
  }

  public async skip(actor: PlaybackActor): Promise<void> {
    this.assertControllablePlayer(actor);
    await this.playerGateway.skip(actor.guildId);
  }

  public async previous(actor: PlaybackActor): Promise<void> {
    this.assertControllablePlayer(actor);
    await this.playerGateway.previous(actor.guildId);
  }

  public async changeVolume(
    actor: PlaybackActor,
    delta: number,
    maximum: number,
  ): Promise<void> {
    this.assertControllablePlayer(actor);
    await this.playerGateway.changeVolume(actor.guildId, delta, maximum);
  }

  public async setVolume(actor: PlaybackActor, volume: number, maximum: number): Promise<void> {
    this.assertControllablePlayer(actor);
    await this.playerGateway.setVolume(actor.guildId, volume, maximum);
  }

  public async shuffle(actor: PlaybackActor): Promise<void> {
    this.assertControllablePlayer(actor);
    await this.playerGateway.shuffle(actor.guildId);
  }

  public getQueue(guildId: string): readonly EnqueueResult["firstTrack"][] {
    return this.playerGateway.getQueue(guildId);
  }

  public async removeQueueTrack(actor: PlaybackActor, position: number): Promise<EnqueueResult["firstTrack"]> {
    this.assertControllablePlayer(actor);
    return this.playerGateway.removeQueueTrack(actor.guildId, position);
  }

  public async clearQueue(actor: PlaybackActor): Promise<number> {
    this.assertControllablePlayer(actor);
    return this.playerGateway.clearQueue(actor.guildId);
  }

  public async setRepeatMode(actor: PlaybackActor, mode: MusicRepeatMode): Promise<void> {
    this.assertControllablePlayer(actor);
    await this.playerGateway.setRepeatMode(actor.guildId, mode);
  }

  public async toggleAutoQueue(actor: PlaybackActor): Promise<boolean> {
    this.assertControllablePlayer(actor);
    return this.playerGateway.toggleAutoQueue(actor.guildId);
  }

  public async toggleTwentyFourSeven(actor: PlaybackActor): Promise<boolean> {
    this.assertControllablePlayer(actor);
    return this.playerGateway.toggleTwentyFourSeven(actor.guildId);
  }

  private assertControllablePlayer(actor: PlaybackActor): void {
    if (!this.playerGateway.hasPlayer(actor.guildId)) {
      throw new MusicPlayerNotFoundError();
    }

    const memberVoiceChannelId = this.requireVoiceChannel(actor);
    this.assertSameVoiceChannel(actor.guildId, memberVoiceChannelId);
  }

  private requireVoiceChannel(actor: PlaybackActor): string {
    const voiceChannelId = actor.member.voice.channelId;
    if (!voiceChannelId) {
      throw new MusicVoiceChannelRequiredError();
    }

    return voiceChannelId;
  }

  private assertSameVoiceChannel(guildId: string, memberVoiceChannelId: string): void {
    const playerVoiceChannelId = this.playerGateway.getVoiceChannelId(guildId);
    if (playerVoiceChannelId && playerVoiceChannelId !== memberVoiceChannelId) {
      throw new MusicVoiceChannelMismatchError();
    }
  }
}
