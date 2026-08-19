import type { PlaybackService } from "../../music/playback-service.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";
import { musicActorAllowed, musicPermissionDeniedMessage } from "./music-tool-support.js";

const maxQueueTracksReturned = 10;

export class MusicQueueTool implements ChatTool<Record<string, never>> {
  public readonly name = "view_music_queue";
  public readonly description = "Shows what's currently playing and what's queued up next.";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {},
  };

  public constructor(private readonly playbackService: PlaybackService) {}

  public execute(_args: Record<string, never>, ctx: ChatToolContext): Promise<ChatToolResult> {
    if (!ctx.music || !musicActorAllowed(ctx.music)) {
      return Promise.resolve({ content: musicPermissionDeniedMessage });
    }
    const snapshot = this.playbackService.getSnapshot(ctx.music.actor.guildId);
    if (!snapshot) return Promise.resolve({ content: "Nothing is playing right now." });
    const queue = this.playbackService.getQueue(ctx.music.actor.guildId).slice(0, maxQueueTracksReturned);
    return Promise.resolve({
      content: JSON.stringify({
        playing: snapshot.playing,
        paused: snapshot.paused,
        volume: snapshot.volume,
        currentTrack: snapshot.currentTrack
          ? { title: snapshot.currentTrack.title, author: snapshot.currentTrack.author }
          : null,
        queueLength: snapshot.queueLength,
        upNext: queue.map((track) => ({ title: track.title, author: track.author })),
      }),
    });
  }
}
