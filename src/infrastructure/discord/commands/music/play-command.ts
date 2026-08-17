import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import {
  createPlaybackActor,
  musicPlaybackAccessPolicy,
} from "./music-command-support.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import {
  createQueuedTrackCard,
  queuedTrackCardLifetimeMs,
} from "../../music/queued-track-card.js";

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
  public readonly access = musicPlaybackAccessPolicy;

  public constructor(
    private readonly playbackService: PlaybackService,
    private readonly profiles: GuildConfigurationProvider,
  ) {}

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

    const profile = this.profiles.require(context.interaction.guildId);
    await context.responses.edit({
      embeds: [createQueuedTrackCard(result, profile.embedColor as `#${string}`)],
    });
    context.responses.deleteAfter(queuedTrackCardLifetimeMs);
  }
}
