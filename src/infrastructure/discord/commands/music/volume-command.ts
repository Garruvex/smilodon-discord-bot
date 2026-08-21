import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type ChatToolBinding, type CommandContext } from "../../../../application/commands/command.js";
import type { ChatToolContext, ChatToolResult } from "../../../../application/chat/tools/chat-tool.js";
import { evaluateMusicToolAccess, formatMusicError, musicPermissionDeniedMessage } from "../../../../application/chat/tools/music-tool-support.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";

interface SetMusicVolumeToolArgs {
  volume: number;
}

export class VolumeCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder().setName("volume").setDescription("Sets playback volume.")
    .addIntegerOption((option) => option.setName("level").setDescription("Volume percentage.").setMinValue(0).setMaxValue(1000).setRequired(true));
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  public readonly toolBinding: ChatToolBinding<SetMusicVolumeToolArgs> = {
    name: "set_music_volume",
    description: "Sets the music player's volume to an absolute percentage (0 is muted, 100 is normal).",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["volume"],
      properties: {
        volume: { type: "integer", description: "Target volume percentage." },
      },
    },
    execute: (args, ctx) => this.executeAsTool(args, ctx),
  };

  public constructor(private readonly playbackService: PlaybackService, private readonly profiles: GuildConfigurationProvider) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const profile = this.profiles.require(context.interaction.guildId);
    const requested = context.interaction.options.getInteger("level", true);
    const level = Math.min(requested, profile.music.maximumVolume);
    await this.playbackService.setVolume(createPlaybackActor(context.interaction), level, profile.music.maximumVolume);
    await context.responses.reply(`Volume set to **${level}%**.`);
  }

  private async executeAsTool(args: SetMusicVolumeToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    if (!ctx.music) return { content: musicPermissionDeniedMessage };
    const decision = evaluateMusicToolAccess(ctx, ctx.music, this.profiles);
    if (!decision.allowed) return { content: musicPermissionDeniedMessage };
    const maximumVolume = this.profiles.require(ctx.guildId).music.maximumVolume;
    const volume = Math.min(Math.max(Math.round(args.volume), 0), maximumVolume);
    try {
      await this.playbackService.setVolume(ctx.music.actor, volume, maximumVolume);
      return { content: `Volume set to ${volume}.` };
    } catch (error) {
      return { content: formatMusicError(error, "Couldn't change the volume right now.") };
    }
  }
}
