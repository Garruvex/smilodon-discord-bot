import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import { createPlaybackActor } from "./music-command-support.js";

export class PlayCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("play")
    .setDescription("Plays a track or adds it to the queue.")
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription("A song name or supported URL.")
        .setRequired(true),
    );

  public readonly module = CommandModule.Music;
  public readonly access = publicAccessPolicy;

  public constructor(private readonly playbackService: PlaybackService) {}

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

    const track = result.firstTrack;
    const description = track.uri.length > 0
      ? `[${track.title}](${track.uri})`
      : track.title;

    const embed = new EmbedBuilder()
      .setTitle(result.startedPlayback ? "Now playing" : "Added to queue")
      .setDescription(description)
      .addFields(
        { name: "Artist", value: track.author, inline: true },
        { name: "Added tracks", value: String(result.addedTrackCount), inline: true },
        { name: "Requested by", value: `<@${track.requestedByUserId}>`, inline: true },
      );

    if (track.artworkUrl) {
      embed.setThumbnail(track.artworkUrl);
    }

    await context.responses.edit({ embeds: [embed] });
  }
}
