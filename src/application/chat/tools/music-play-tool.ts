import type { PlaybackService } from "../../music/playback-service.js";
import { MusicError } from "../../music/music-errors.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";
import { musicActorAllowed, musicPermissionDeniedMessage } from "./music-tool-support.js";

interface MusicPlayToolArgs {
  query: string;
}

// A "play a playlist of X" request is handled by the model calling this tool
// once per track/artist it decides on — enqueue() already appends to the
// queue, so no separate batch/playlist primitive is needed.
export class MusicPlayTool implements ChatTool<MusicPlayToolArgs> {
  public readonly name = "play_music";
  public readonly description =
    "Plays a song or adds it to the queue, given a search query (song name, artist, or a supported URL). " +
    "Call this once per track when asked for a playlist or several songs by an artist/genre.";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", description: "Song name, artist, or URL to search for." },
    },
  };

  public constructor(private readonly playbackService: PlaybackService) {}

  public async execute(args: MusicPlayToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    if (!ctx.music || !musicActorAllowed(ctx.music)) {
      return { content: musicPermissionDeniedMessage };
    }
    try {
      const result = await this.playbackService.enqueue(ctx.music.actor, args.query);
      return {
        content: JSON.stringify({
          title: result.firstTrack.title,
          author: result.firstTrack.author,
          startedPlayback: result.startedPlayback,
          queuePosition: result.queuePosition,
          addedTrackCount: result.addedTrackCount,
        }),
      };
    } catch (error) {
      return { content: error instanceof MusicError ? error.message : "Couldn't play that right now." };
    }
  }
}
