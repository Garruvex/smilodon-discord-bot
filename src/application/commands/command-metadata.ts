// Discord-independent command/option metadata — plain data, no discord.js
// import. A separate infra helper (command-metadata-builder.ts) converts
// this into a live discord.js SlashCommandBuilder for registration/deploy;
// application-layer code (CommandRegistry, HelpCommand) reads this shape
// directly instead of a builder instance.

export interface CommandOptionChoice {
  name: string;
  value: string;
}

interface BaseOptionMetadata {
  name: string;
  description: string;
  required?: boolean;
}

export interface StringOptionMetadata extends BaseOptionMetadata {
  type: "string";
  maxLength?: number;
  choices?: readonly CommandOptionChoice[];
}

export interface IntegerOptionMetadata extends BaseOptionMetadata {
  type: "integer";
  minValue?: number;
  maxValue?: number;
}

export interface BooleanOptionMetadata extends BaseOptionMetadata {
  type: "boolean";
}

export interface ChannelOptionMetadata extends BaseOptionMetadata {
  type: "channel";
  // Every channel option in this codebase restricts to sendable text
  // channels (regular + announcement) — kept as an explicit flag (rather
  // than a general channel-types array) since no other channel type is
  // used anywhere; extend if that changes.
  guildTextOnly?: boolean;
}

export interface RoleOptionMetadata extends BaseOptionMetadata {
  type: "role";
}

export interface UserOptionMetadata extends BaseOptionMetadata {
  type: "user";
}

export interface AttachmentOptionMetadata extends BaseOptionMetadata {
  type: "attachment";
}

export type CommandOptionMetadata =
  | StringOptionMetadata
  | IntegerOptionMetadata
  | BooleanOptionMetadata
  | ChannelOptionMetadata
  | RoleOptionMetadata
  | UserOptionMetadata
  | AttachmentOptionMetadata;

export interface SubcommandMetadata {
  name: string;
  description: string;
  options?: readonly CommandOptionMetadata[];
}

export interface SubcommandGroupMetadata {
  name: string;
  description: string;
  subcommands: readonly SubcommandMetadata[];
}

// A command has either flat `options`, `subcommands`, `subcommandGroups`, or
// none of the three (a no-arg command) — never a mix, mirroring discord.js's
// own SlashCommandBuilder/SlashCommandSubcommandsOnlyBuilder split.
export interface ChatInputCommandMetadata {
  type?: "chatInput";
  name: string;
  description: string;
  dmPermission?: boolean;
  nsfw?: boolean;
  options?: readonly CommandOptionMetadata[];
  subcommands?: readonly SubcommandMetadata[];
  subcommandGroups?: readonly SubcommandGroupMetadata[];
}

// A right-click "Apps" entry on a message — Discord forbids a description on
// these, unlike chat-input commands.
export interface MessageContextMenuCommandMetadata {
  type: "messageContextMenu";
  name: string;
  dmPermission?: boolean;
}

export type CommandType = "chatInput" | "messageContextMenu";
export type CommandMetadata = ChatInputCommandMetadata | MessageContextMenuCommandMetadata;

export function commandTypeOf(metadata: CommandMetadata): CommandType {
  return metadata.type ?? "chatInput";
}
