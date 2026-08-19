import type { PlaybackService } from "../../music/playback-service.js";
import { MusicError } from "../../music/music-errors.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";
import { musicActorAllowed, musicPermissionDeniedMessage } from "./music-tool-support.js";

interface MusicVolumeToolArgs {
  volume: number;
}

export class MusicVolumeTool implements ChatTool<MusicVolumeToolArgs> {
  public readonly name = "set_music_volume";
  public readonly description = "Sets the music player's volume to an absolute percentage (0 is muted, 100 is normal).";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: ["volume"],
    properties: {
      volume: { type: "integer", description: "Target volume percentage." },
    },
  };

  public constructor(private readonly playbackService: PlaybackService) {}

  public async execute(args: MusicVolumeToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    if (!ctx.music || !musicActorAllowed(ctx.music)) {
      return { content: musicPermissionDeniedMessage };
    }
    const volume = Math.min(Math.max(Math.round(args.volume), 0), ctx.music.volumeMaximum);
    try {
      await this.playbackService.setVolume(ctx.music.actor, volume, ctx.music.volumeMaximum);
      return { content: `Volume set to ${volume}.` };
    } catch (error) {
      return { content: error instanceof MusicError ? error.message : "Couldn't change the volume right now." };
    }
  }
}
