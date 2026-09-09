import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";

export class MoveCommand implements BotCommand {
  public readonly definition = {
    name: "move",
    description: "Moves a queued track to a different position.",
    options: [
      { type: "integer", name: "track", description: "The queue position of the track to move, starting at 1.", minValue: 1, required: true },
      { type: "integer", name: "position", description: "The queue position to move it to, starting at 1.", minValue: 1, required: true },
    ],
  } satisfies BotCommand["definition"];
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  public constructor(private readonly playbackService: PlaybackService) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const from = context.interaction.options.getInteger("track", true);
    const to = context.interaction.options.getInteger("position", true);
    const actor = createPlaybackActor(context.interaction, context.access.bypassVoiceChannelCheck, context.access.allowQueueWithoutVoiceChannel);
    const track = await this.playbackService.moveQueueTrack(actor, from, to);
    await context.responses.reply(`Moved **${track.title}** to position **${to}**.`);
  }
}
