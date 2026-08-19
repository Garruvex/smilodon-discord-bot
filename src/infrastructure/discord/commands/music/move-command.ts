import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";

export class MoveCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("move")
    .setDescription("Moves a queued track to a different position.")
    .addIntegerOption((option) => option
      .setName("track")
      .setDescription("The queue position of the track to move, starting at 1.")
      .setMinValue(1)
      .setRequired(true))
    .addIntegerOption((option) => option
      .setName("position")
      .setDescription("The queue position to move it to, starting at 1.")
      .setMinValue(1)
      .setRequired(true));
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  public constructor(private readonly playbackService: PlaybackService) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const from = context.interaction.options.getInteger("track", true);
    const to = context.interaction.options.getInteger("position", true);
    const track = await this.playbackService.moveQueueTrack(createPlaybackActor(context.interaction), from, to);
    await context.responses.reply(`Moved **${track.title}** to position **${to}**.`);
  }
}
