import type { ChatInputCommandInteraction, MessageContextMenuCommandInteraction } from "discord.js";
import type { Logger } from "pino";

import type { AccessPolicyService } from "../access/access-policy-service.js";
import type { CommandRegistry } from "./command-registry.js";
import { MusicError } from "../music/music-errors.js";
import { GuildAssetError } from "../assets/guild-asset-store.js";
import { CommandResponseVisibility } from "./command.js";
import { CommandResponses } from "./command-responses.js";
import type { CommandType } from "./command-metadata.js";

export class CommandDispatcher {
  public constructor(
    private readonly registry: CommandRegistry,
    private readonly accessPolicyService: AccessPolicyService,
    private readonly logger: Logger,
  ) {}

  public async dispatch(
    interaction: ChatInputCommandInteraction | MessageContextMenuCommandInteraction,
  ): Promise<void> {
    const commandType: CommandType = interaction.isMessageContextMenuCommand()
      ? "messageContextMenu"
      : "chatInput";
    const command = this.registry.find(interaction.commandName, commandType);

    if (!command) {
      const responses = new CommandResponses(interaction, CommandResponseVisibility.Ephemeral);
      await responses.error(
        "This command is not available. It may have been removed or replaced.",
        "Command unavailable",
      );
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

      await responses.error(
        "You are not allowed to use this command here.",
        "Permission denied",
      );
      return;
    }

    const commandLogger = this.logger.child({
      commandName: interaction.commandName,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
    });
    try {
      await command.execute({ interaction, logger: commandLogger, responses });
    } catch (error) {
      commandLogger.error({ err: error }, "Command execution failed");

      const userFacingError = error instanceof MusicError || error instanceof GuildAssetError;

      await responses.error(
        userFacingError
          ? error.message
          : "The command could not be completed. The error has been logged.",
        error instanceof MusicError ? "Music command unavailable" : "Command error",
      );
    }
  }
}
