import type { PlaybackService } from "../../music/playback-service.js";
import { MusicError } from "../../music/music-errors.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";
import { musicActorAllowed, musicPermissionDeniedMessage } from "./music-tool-support.js";

type MusicControlAction = "pause" | "resume" | "stop" | "skip" | "previous" | "shuffle";

interface MusicControlToolArgs {
  action: MusicControlAction;
}

export class MusicControlTool implements ChatTool<MusicControlToolArgs> {
  public readonly name = "control_music";
  public readonly description =
    "Controls the current music player: pause, resume, stop (clears the queue and leaves), skip the current " +
    "track, go back to the previous track, or shuffle the queue.";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: {
        type: "string",
        enum: ["pause", "resume", "stop", "skip", "previous", "shuffle"],
        description: "Which playback control to perform.",
      },
    },
  };

  public constructor(private readonly playbackService: PlaybackService) {}

  public async execute(args: MusicControlToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    if (!ctx.music || !musicActorAllowed(ctx.music)) {
      return { content: musicPermissionDeniedMessage };
    }
    try {
      await this.playbackService[args.action](ctx.music.actor);
      return { content: `${args.action} succeeded.` };
    } catch (error) {
      return { content: error instanceof MusicError ? error.message : "That music control action failed." };
    }
  }
}
