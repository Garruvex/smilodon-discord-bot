import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";

export class SkipToCommand implements BotCommand {
  public readonly definition = {
    name: "skipto",
    description: "Skips ahead to a specific track in the queue.",
    options: [
      { type: "integer", name: "position", description: "Queue position, starting at 1.", minValue: 1, required: true },
    ],
  } satisfies BotCommand["definition"];
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  public constructor(private readonly playbackService: PlaybackService) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const position = context.interaction.options.getInteger("position", true);
    const actor = createPlaybackActor(context.interaction, context.access.bypassVoiceChannelCheck);
    const track = await this.playbackService.skipTo(actor, position);
    await context.responses.reply(`Skipped to **${track.title}** — ${track.author}.`);
  }
}
