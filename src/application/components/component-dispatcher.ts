import { MessageFlags, type MessageComponentInteraction } from "discord.js";
import type { Logger } from "pino";

import type { AccessPolicyService } from "../access/access-policy-service.js";
import type { ComponentRegistry } from "./component-registry.js";

export class ComponentDispatcher {
  public constructor(
    private readonly registry: ComponentRegistry,
    private readonly accessPolicyService: AccessPolicyService,
    private readonly logger: Logger,
  ) {}

  public async dispatch(interaction: MessageComponentInteraction): Promise<void> {
    const handler = this.registry.find(interaction.customId);
    if (!handler) return;

    const accessDecision = this.accessPolicyService.evaluate(
      handler.access,
      handler.module,
      interaction,
    );
    if (!accessDecision.allowed) {
      this.logger.warn(
        {
          componentId: interaction.customId,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          denialReason: accessDecision.reason,
        },
        "Component access denied",
      );
      await interaction.reply({
        content: "You are not allowed to use this control here.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const componentLogger = this.logger.child({
      componentId: interaction.customId,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      userId: interaction.user.id,
    });

    try {
      await handler.execute({ interaction, logger: componentLogger });
    } catch (error) {
      componentLogger.error({ err: error }, "Component execution failed");
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "The control could not be completed. The error has been logged.",
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  }
}
