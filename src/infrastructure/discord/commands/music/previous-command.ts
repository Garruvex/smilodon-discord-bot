import { SlashCommandBuilder } from "discord.js";
import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";
export class PreviousCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder().setName("previous").setDescription("Plays the previous track.");
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;
  public constructor(private readonly playbackService: PlaybackService) {}
  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    await this.playbackService.previous(createPlaybackActor(context.interaction));
    await context.responses.reply("Playing the previous track.");
  }
}
