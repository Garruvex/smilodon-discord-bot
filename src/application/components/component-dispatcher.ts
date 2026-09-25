import { MessageFlags, type MessageComponentInteraction, type ModalSubmitInteraction } from "discord.js";
import type { Logger } from "pino";

import type { AccessPolicyService } from "../access/access-policy-service.js";
import type { ComponentHandler } from "./component-handler.js";
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
    await this.run(handler, interaction, (logger) => handler.execute({ interaction, logger }));
  }

  public async dispatchModal(interaction: ModalSubmitInteraction): Promise<void> {
    const handler = this.registry.find(interaction.customId);
    if (!handler?.executeModal) return;
    const executeModal = handler.executeModal.bind(handler);
    await this.run(handler, interaction, (logger) => executeModal({ interaction, logger }));
  }

  private async run(
    handler: ComponentHandler,
    interaction: MessageComponentInteraction | ModalSubmitInteraction,
    execute: (logger: Logger) => Promise<void>,
  ): Promise<void> {
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
      await execute(componentLogger);
    } catch (error) {
      componentLogger.error({ err: error }, "Component execution failed");
      const content = "The control could not be completed. The error has been logged.";
      if (interaction.deferred && !interaction.replied) {
        await interaction.editReply({ content });
      } else if (interaction.replied) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    }
  }
}
