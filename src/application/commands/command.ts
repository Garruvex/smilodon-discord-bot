import type { ChatInputCommandInteraction, MessageContextMenuCommandInteraction } from "discord.js";
import type { Logger } from "pino";

import type { CommandAccessPolicy } from "../../domain/access/access-policy.js";
import type { CommandResponses } from "./command-responses.js";
import type { ChatToolContext, ChatToolParameterSchema, ChatToolResult } from "../chat/tools/chat-tool.js";
import type {
  ChatInputCommandMetadata,
  MessageContextMenuCommandMetadata,
} from "./command-metadata.js";

export enum CommandModule {
  Bootstrap = "bootstrap",
  Common = "common",
  Diagnostics = "diagnostics",
  Music = "music",
  Birthdays = "birthdays",
  Reminders = "reminders",
  Nsfw = "nsfw",
}

export enum CommandResponseVisibility {
  Ephemeral = "ephemeral",
  Public = "public",
}

export type AnyCommandInteraction = ChatInputCommandInteraction | MessageContextMenuCommandInteraction;

export type CommandDefinition<
  TInteraction extends AnyCommandInteraction = ChatInputCommandInteraction,
> = TInteraction extends MessageContextMenuCommandInteraction
  ? MessageContextMenuCommandMetadata
  : ChatInputCommandMetadata;

// Generic over the interaction kind, defaulting to chat-input, so the ~30
// existing chat-input commands (which access `interaction.options` without
// narrowing) are unaffected — only a command that opts into a different
// interaction kind (e.g. a message context-menu command) needs to say so.
export interface CommandContext<TInteraction extends AnyCommandInteraction = ChatInputCommandInteraction> {
  interaction: TInteraction;
  logger: Logger;
  responses: CommandResponses;
  // The AccessPolicyEngine decision that already granted this invocation —
  // see AccessDecision.bypassVoiceChannelCheck /
  // AccessDecision.allowQueueWithoutVoiceChannel. Only Music-module commands
  // read these; both are false (a no-op) for every other module.
  access: { bypassVoiceChannelCheck: boolean; allowQueueWithoutVoiceChannel: boolean };
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

export interface BotCommand<TInteraction extends AnyCommandInteraction = ChatInputCommandInteraction> {
  readonly definition: CommandDefinition<TInteraction>;
  readonly module: CommandModule;
  readonly access: CommandAccessPolicy;
  readonly responseVisibility?: CommandResponseVisibility;
  readonly toolBinding?: ChatToolBinding;

  execute(context: CommandContext<TInteraction>): Promise<void>;
}
