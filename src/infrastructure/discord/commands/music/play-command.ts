import { CommandModule, type BotCommand, type ChatToolBinding, type CommandContext } from "../../../../application/commands/command.js";
import type { ChatToolContext, ChatToolResult } from "../../../../application/chat/tools/chat-tool.js";
import {
  evaluateMusicToolAccess,
  formatMusicError,
  musicPermissionDeniedMessage,
  musicToolTimedOutMessage,
  musicToolWasCancelled,
} from "../../../../application/chat/tools/music-tool-support.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import {
  createPlaybackActor,
  musicPlaybackAccessPolicy,
} from "./music-command-support.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import {
  createQueuedTrackCard,
  queuedTrackCardLifetimeMs,
} from "../../music/queued-track-card.js";

interface PlayMusicToolArgs {
  query: string;
}

export class PlayCommand implements BotCommand {
  public readonly definition = {
    name: "play",
    description: "Plays a track or adds it to the queue.",
    options: [
      { type: "string", name: "query", description: "A song name or supported URL.", required: true },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  // A "play a playlist of X" request is handled by the model calling this
  // tool once per track/artist it decides on — enqueue() already appends to
  // the queue, so no separate batch/playlist primitive is needed.
  public readonly toolBinding: ChatToolBinding<PlayMusicToolArgs> = {
    name: "play_music",
    description:
      "Plays a song or adds it to the queue, given a search query (song name, artist, or a supported URL). " +
      "Call this once per track when asked for a playlist or several songs by an artist/genre.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Song name, artist, or URL to search for." },
      },
    },
    execute: (args, ctx) => this.executeAsTool(args, ctx),
  };

  public constructor(
    private readonly playbackService: PlaybackService,
    private readonly profiles: GuildConfigurationProvider,
  ) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) {
      await context.responses.reply("Music commands are only available in a server.");
      return;
    }

    await context.responses.defer();
    const query = context.interaction.options.getString("query", true);
    const result = await this.playbackService.enqueue(
      createPlaybackActor(context.interaction),
      query,
    );

    const profile = this.profiles.require(context.interaction.guildId);
    await context.responses.edit({
      embeds: [createQueuedTrackCard(result, profile.embedColor as `#${string}`)],
    });
    context.responses.deleteAfter(queuedTrackCardLifetimeMs);
  }

  private async executeAsTool(args: PlayMusicToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    if (!ctx.music) return { content: musicPermissionDeniedMessage };
    const decision = evaluateMusicToolAccess(ctx, ctx.music, this.profiles);
    if (!decision.allowed) return { content: musicPermissionDeniedMessage };
    if (musicToolWasCancelled(ctx)) return { content: musicToolTimedOutMessage };
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
      return { content: formatMusicError(error, "Couldn't play that right now.") };
    }
  }
}
