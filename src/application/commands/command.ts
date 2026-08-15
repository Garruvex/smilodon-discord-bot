import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { Logger } from "pino";

import type { CommandAccessPolicy } from "../../domain/access/access-policy.js";
import type { CommandResponses } from "./command-responses.js";

export type CommandDefinition =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

export enum CommandModule {
  Bootstrap = "bootstrap",
  Common = "common",
  Diagnostics = "diagnostics",
  Music = "music",
}

export enum CommandResponseVisibility {
  Ephemeral = "ephemeral",
  Public = "public",
}

export interface CommandContext {
  interaction: ChatInputCommandInteraction;
  logger: Logger;
  responses: CommandResponses;
}

export interface BotCommand {
  readonly definition: CommandDefinition;
  readonly module: CommandModule;
  readonly access: CommandAccessPolicy;
  readonly responseVisibility?: CommandResponseVisibility;

  execute(context: CommandContext): Promise<void>;
}
