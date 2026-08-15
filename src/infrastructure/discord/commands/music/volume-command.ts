import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";

export class VolumeCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder().setName("volume").setDescription("Sets playback volume.")
    .addIntegerOption((option) => option.setName("level").setDescription("Volume percentage.").setMinValue(0).setMaxValue(1000).setRequired(true));
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;
  public constructor(private readonly playbackService: PlaybackService, private readonly profiles: GuildConfigurationProvider) {}
  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const profile = this.profiles.require(context.interaction.guildId);
    const requested = context.interaction.options.getInteger("level", true);
    const level = Math.min(requested, profile.music.maximumVolume);
    await this.playbackService.setVolume(createPlaybackActor(context.interaction), level, profile.music.maximumVolume);
    await context.responses.reply(`Volume set to **${level}%**.`);
  }
}
