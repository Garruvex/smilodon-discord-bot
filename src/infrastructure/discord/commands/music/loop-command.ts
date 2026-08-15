import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { MusicRepeatMode } from "../../../../application/music/music-player-gateway.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";

export class LoopCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("loop")
    .setDescription("Sets the playback repeat mode.")
    .addStringOption((option) => option.setName("mode").setDescription("Repeat mode.").setRequired(true)
      .addChoices({ name: "Off", value: "off" }, { name: "Current track", value: "track" }, { name: "Queue", value: "queue" }));
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;
  public constructor(private readonly playbackService: PlaybackService) {}
  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const mode = context.interaction.options.getString("mode", true) as MusicRepeatMode;
    await this.playbackService.setRepeatMode(createPlaybackActor(context.interaction), mode);
    await context.responses.reply(`Repeat mode set to **${mode}**.`);
  }
}
