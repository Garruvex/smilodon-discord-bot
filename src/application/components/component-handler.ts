import type { MessageComponentInteraction } from "discord.js";
import type { Logger } from "pino";

import type { CommandAccessPolicy } from "../../domain/access/access-policy.js";
import type { CommandModule } from "../commands/command.js";

export interface ComponentContext {
  interaction: MessageComponentInteraction;
  logger: Logger;
}

export interface ComponentHandler {
  readonly customIdPrefix: string;
  readonly module: CommandModule;
  readonly access: CommandAccessPolicy;

  execute(context: ComponentContext): Promise<void>;
}
