import { CommandModule } from "../../../application/commands/command.js";
import { defaultLanguage } from "../../../application/i18n/language.js";
import { texts } from "../../../application/i18n/texts.js";
import type { ComponentContext, ComponentHandler } from "../../../application/components/component-handler.js";
import { musicPlaybackAccessPolicy } from "../../../application/music/music-access-policy.js";
import type { PlaybackService } from "../../../application/music/playback-service.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { buildQueuePageView, queuePageComponentIdPrefix } from "../music/queue-page-view.js";

export class QueuePageComponentHandler implements ComponentHandler {
  public readonly customIdPrefix = queuePageComponentIdPrefix;
  public readonly module = CommandModule.Music;
  public readonly access = musicPlaybackAccessPolicy;

  public constructor(
    private readonly playbackService: PlaybackService,
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
  ) {}

  public async execute(context: ComponentContext): Promise<void> {
    const interaction = context.interaction;
    if (!interaction.isButton() || !interaction.inCachedGuild()) return;

    const page = Number(interaction.customId.split(":")[1]);
    const profile = this.guildConfigurationProvider.find(interaction.guildId);
    const tracks = this.playbackService.getQueue(interaction.guildId);
    const view = buildQueuePageView(
      tracks,
      Number.isFinite(page) ? page : 0,
      (profile?.embedColor ?? "#3B82F6") as `#${string}`,
      texts[profile?.language ?? defaultLanguage],
    );
    await interaction.update({ embeds: [view.embed], components: view.components });
  }
}
