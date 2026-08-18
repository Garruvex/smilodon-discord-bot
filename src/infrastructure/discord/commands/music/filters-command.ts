import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { MusicFilterPreset } from "../../../../application/music/music-player-gateway.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";

const presetLabels: Record<MusicFilterPreset, string> = {
  off: "Off",
  nightcore: "Nightcore",
  vaporwave: "Vaporwave",
  bassboost: "Bassboost",
  pop: "Pop",
  eightD: "8D",
  karaoke: "Karaoke",
  vibrato: "Vibrato",
  tremolo: "Tremolo",
};

export class FiltersCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("filters")
    .setDescription("Applies an audio filter preset to playback.")
    .addStringOption((option) => option.setName("preset").setDescription("The filter preset to apply.").setRequired(true)
      .addChoices(...Object.entries(presetLabels).map(([value, name]) => ({ name, value }))));

  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  public constructor(private readonly playbackService: PlaybackService) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const preset = context.interaction.options.getString("preset", true) as MusicFilterPreset;
    await this.playbackService.setFilterPreset(createPlaybackActor(context.interaction), preset);
    await context.responses.reply(
      preset === "off" ? "Filters cleared." : `Applied the **${presetLabels[preset]}** filter.`,
    );
  }
}
