import type { MessageComponentInteraction, ModalSubmitInteraction } from "discord.js";
import type { Logger } from "pino";

import type { CommandAccessPolicy } from "../../domain/access/access-policy.js";
import type { CommandModule } from "../commands/command.js";

export interface ComponentContext {
  interaction: MessageComponentInteraction;
  logger: Logger;
}

export interface ModalContext {
  interaction: ModalSubmitInteraction;
  logger: Logger;
}

export interface ComponentHandler {
  readonly customIdPrefix: string;
  readonly module: CommandModule;
  readonly access: CommandAccessPolicy;

  execute(context: ComponentContext): Promise<void>;
  // For handlers whose controls open a modal: the submit arrives with the
  // same customId prefix and passes the same access check.
  executeModal?(context: ModalContext): Promise<void>;
}
