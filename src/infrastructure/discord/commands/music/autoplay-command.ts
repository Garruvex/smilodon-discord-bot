import { SlashCommandBuilder } from "discord.js";
import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";
export class AutoplayCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder().setName("autoplay").setDescription("Toggles automatic related-track queueing.");
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;
  public constructor(private readonly playbackService: PlaybackService) {}
  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const enabled = await this.playbackService.toggleAutoQueue(createPlaybackActor(context.interaction));
    await context.responses.reply(`Autoqueue ${enabled ? "enabled" : "disabled"}.`);
  }
}
