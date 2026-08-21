import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
} from "discord.js";
import type { Logger } from "pino";

import type { CommandAccessPolicy } from "../../domain/access/access-policy.js";
import type { CommandResponses } from "./command-responses.js";
import type { ChatToolContext, ChatToolParameterSchema, ChatToolResult } from "../chat/tools/chat-tool.js";

export type CommandDefinition =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

export enum CommandModule {
  Bootstrap = "bootstrap",
  Common = "common",
  Diagnostics = "diagnostics",
  Music = "music",
  Birthdays = "birthdays",
  Nsfw = "nsfw",
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

// Declared next to a command's own `definition` so a command's LLM exposure
// has a single source of truth (see ChatToolRegistry, built by filtering
// CommandRegistry.getAll() for commands that set this). Opt-in only —
// nothing is exposed to the model just by existing as a slash command.
export interface ChatToolBinding<TArgs = unknown> {
  // Sent to the model as the function's name — must match Responses API
  // function-name constraints (letters, digits, underscores). Not required
  // to match the slash command's own name.
  name: string;
  description: string;
  parameters: ChatToolParameterSchema;
  // Never throws — see ChatTool.execute (chat-tool.ts) for the same
  // contract: a failed lookup or denied access is reported back to the
  // model as a ChatToolResult, not an exception.
  execute(args: TArgs, ctx: ChatToolContext): Promise<ChatToolResult>;
}

export interface BotCommand {
  readonly definition: CommandDefinition;
  readonly module: CommandModule;
  readonly access: CommandAccessPolicy;
  readonly responseVisibility?: CommandResponseVisibility;
  readonly toolBinding?: ChatToolBinding;

  execute(context: CommandContext): Promise<void>;
}
