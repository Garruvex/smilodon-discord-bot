import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PlaybackService } from "../../../../application/music/playback-service.js";
import { createPlaybackActor, musicPlaybackAccessPolicy } from "./music-command-support.js";

export class QueueCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Views or manages the music queue.")
    .addSubcommand((command) => command.setName("show").setDescription("Shows queued tracks."))
    .addSubcommand((command) => command
      .setName("remove")
      .setDescription("Removes a queued track by position.")
      .addIntegerOption((option) => option.setName("position").setDescription("Queue position, starting at 1.").setMinValue(1).setRequired(true)))
    .addSubcommand((command) => command.setName("clear").setDescription("Clears every upcoming track."))
    .addSubcommand((command) => command.setName("history").setDescription("Shows recently played tracks."));

  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  public constructor(private readonly playbackService: PlaybackService) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) return;
    const action = context.interaction.options.getSubcommand(true);
    if (action === "remove") {
      const track = await this.playbackService.removeQueueTrack(
        createPlaybackActor(context.interaction),
        context.interaction.options.getInteger("position", true),
      );
      await context.responses.reply(`Removed **${track.title}** from the queue.`);
      return;
    }
    if (action === "clear") {
      const count = await this.playbackService.clearQueue(createPlaybackActor(context.interaction));
      await context.responses.reply(`Cleared ${count} queued track${count === 1 ? "" : "s"}.`);
      return;
    }
    if (action === "history") {
      const history = this.playbackService.getPlayHistory(context.interaction.guildId);
      const description = history.length === 0
        ? "Nothing has played in this server yet."
        : history.map((track, index) => `${index + 1}. **${track.title}** — ${track.author}`).join("\n");
      const embed = new EmbedBuilder().setTitle("Recently played").setDescription(description);
      await context.responses.reply({ embeds: [embed] });
      return;
    }

    const tracks = this.playbackService.getQueue(context.interaction.guildId);
    const description = tracks.length === 0
      ? "There are no upcoming tracks."
      : tracks.slice(0, 20).map((track, index) => `${index + 1}. **${track.title}** — ${track.author}`).join("\n");
    const embed = new EmbedBuilder().setTitle("Music queue").setDescription(description);
    if (tracks.length > 20) embed.setFooter({ text: `Showing 20 of ${tracks.length} tracks` });
    await context.responses.reply({ embeds: [embed] });
  }
}
