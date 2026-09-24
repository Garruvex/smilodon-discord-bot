import type { ChatInputCommandInteraction, MessageContextMenuCommandInteraction } from "discord.js";
import type { Logger } from "pino";

import type { AccessPolicyService } from "../access/access-policy-service.js";
import { defaultLanguage, type Language } from "../i18n/language.js";
import { texts } from "../i18n/texts.js";
import type { CommandRegistry } from "./command-registry.js";
import { musicErrorText, MusicError } from "../music/music-errors.js";
import { GuildAssetError } from "../assets/guild-asset-store.js";
import { CommandResponseVisibility } from "./command.js";
import { CommandResponses } from "./command-responses.js";
import type { CommandType } from "./command-metadata.js";

export class CommandDispatcher {
  public constructor(
    private readonly registry: CommandRegistry,
    private readonly accessPolicyService: AccessPolicyService,
    private readonly logger: Logger,
    // The server's configured language. Defaults to English when not wired
    // up (tests) or when there's no server (DMs).
    private readonly languageFor: (guildId: string | null) => Language = () => defaultLanguage,
  ) {}

  public async dispatch(
    interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
  ): Promise<void> {
    const commandType: CommandType = interaction.isMessageContextMenuCommand()
      ? "messageContextMenu"
      : "chatInput";
    const command = this.registry.find(interaction.commandName, commandType);
    const text = texts[this.languageFor(interaction.guildId)];

    if (!command) {
      const responses = new CommandResponses(interaction, CommandResponseVisibility.Ephemeral);
      await responses.error(text.command.unavailable, text.command.unavailableTitle);
      return;
    }

    const responses = new CommandResponses(
      interaction,
      command.responseVisibility ?? CommandResponseVisibility.Ephemeral,
    );

    const accessDecision = this.accessPolicyService.evaluate(
      command.access,
      command.module,
      interaction,
    );

    if (!accessDecision.allowed) {
      this.logger.warn(
        {
          commandName: interaction.commandName,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          denialReason: accessDecision.reason,
        },
        "Command access denied",
      );

      await responses.error(text.command.denied, text.command.deniedTitle);
      return;
    }

    const commandLogger = this.logger.child({
      commandName: interaction.commandName,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
    });
    try {
      await command.execute({
        interaction,
        logger: commandLogger,
        responses,
        text,
        access: {
          bypassVoiceChannelCheck: accessDecision.bypassVoiceChannelCheck,
          allowQueueWithoutVoiceChannel: accessDecision.allowQueueWithoutVoiceChannel,
        },
      });
    } catch (error) {
      commandLogger.error({ err: error }, "Command execution failed");

      const userFacingError = error instanceof MusicError || error instanceof GuildAssetError;

      await responses.error(
        error instanceof MusicError
          ? musicErrorText(error, text)
          : userFacingError
            ? error.message
            : text.command.failed,
        error instanceof MusicError ? text.command.musicErrorTitle : text.command.errorTitle,
      );
    }
  }
}
