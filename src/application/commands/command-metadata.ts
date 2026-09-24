// Discord-independent command/option metadata — plain data, no discord.js
// import. A separate infra helper (command-metadata-builder.ts) converts
// this into a live discord.js SlashCommandBuilder for registration/deploy;
// application-layer code (CommandRegistry, HelpCommand) reads this shape
// directly instead of a builder instance.

// Discord locale → text. A command normally leaves these out and gets its
// translations from the description catalogs by path (see
// i18n/command-descriptions); a command that owns its text — the settings
// commands, built from the settings registry — embeds them instead.
export type Localizations = Readonly<Record<string, string>>;

export interface CommandOptionChoice {
  name: string;
  value: string;
  nameLocalizations?: Localizations;
}

interface BaseOptionMetadata {
  name: string;
  description: string;
  descriptionLocalizations?: Localizations;
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
  // Restricts the picker to voice/stage channels — used by /play's optional
  // target-channel option.
  voiceOnly?: boolean;
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
  descriptionLocalizations?: Localizations;
  options?: readonly CommandOptionMetadata[];
}

export interface SubcommandGroupMetadata {
  name: string;
  description: string;
  descriptionLocalizations?: Localizations;
  subcommands: readonly SubcommandMetadata[];
}

// A command has either flat `options`, `subcommands`, `subcommandGroups`, or
// none of the three (a no-arg command) — never a mix, mirroring discord.js's
// own SlashCommandBuilder/SlashCommandSubcommandsOnlyBuilder split.
export interface ChatInputCommandMetadata {
  type?: "chatInput";
  name: string;
  description: string;
  descriptionLocalizations?: Localizations;
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
