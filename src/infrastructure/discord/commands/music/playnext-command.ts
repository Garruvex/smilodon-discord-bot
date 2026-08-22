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

export class PlayNextCommand implements BotCommand {
  public readonly definition = {
    name: "playnext",
    description: "Plays a track or adds it to the front of the queue.",
    options: [
      { type: "string", name: "query", description: "A song name or supported URL.", required: true },
    ],
  } satisfies BotCommand["definition"];

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
    const actor = createPlaybackActor(context.interaction);
    const result = await this.playbackService.enqueue(actor, query);

    if (
      !result.startedPlayback &&
      result.addedTrackCount === 1 &&
      result.queuePosition !== null &&
      result.queuePosition > 1
    ) {
      await this.playbackService.moveQueueTrack(actor, result.queuePosition, 1);
      result.queuePosition = 1;
    }

    const profile = this.profiles.require(context.interaction.guildId);
    await context.responses.edit({
      embeds: [createQueuedTrackCard(result, profile.embedColor as `#${string}`)],
    });
    context.responses.deleteAfter(queuedTrackCardLifetimeMs);
  }
}
