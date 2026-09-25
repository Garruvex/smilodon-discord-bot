import {
  ApplicationCommandType,
  ChannelType,
  ContextMenuCommandBuilder,
  SlashCommandBuilder,
  type SlashCommandSubcommandBuilder,
  type SlashCommandSubcommandGroupBuilder,
} from "discord.js";

import type {
  ChatInputCommandMetadata,
  CommandOptionMetadata,
  Localizations,
  MessageContextMenuCommandMetadata,
  SubcommandGroupMetadata,
  SubcommandMetadata,
} from "../../../application/commands/command-metadata.js";
import { commandDescriptionKey, localizedDescriptionsFor } from "../../../application/i18n/command-descriptions/index.js";

// Attaches the node's translated descriptions: its own embedded ones when it
// has them, otherwise whatever the catalogs have for `key`. A node with
// neither keeps just its English description. Only descriptions (and choice
// names) are localized; command, subcommand and option names stay as-is.
function localizeDescription(
  target: { setDescriptionLocalizations(localizations: Record<string, string>): unknown },
  key: string,
  embedded: Localizations | undefined,
): void {
  const localizations = embedded ?? localizedDescriptionsFor(key);
  if (localizations) target.setDescriptionLocalizations({ ...localizations });
}

function addOption(
  builder: SlashCommandBuilder | SlashCommandSubcommandBuilder,
  option: CommandOptionMetadata,
  path: readonly string[],
): void {
  const key = commandDescriptionKey(path, option.name);
  switch (option.type) {
    case "string":
      builder.addStringOption((o) => {
        o.setName(option.name).setDescription(option.description);
        localizeDescription(o, key, option.descriptionLocalizations);
        if (option.required !== undefined) o.setRequired(option.required);
        if (option.maxLength !== undefined) o.setMaxLength(option.maxLength);
        if (option.choices) {
          o.addChoices(...option.choices.map((choice) => ({
            name: choice.name,
            value: choice.value,
            ...(choice.nameLocalizations ? { name_localizations: { ...choice.nameLocalizations } } : {}),
          })));
        }
        return o;
      });
      return;
    case "integer":
      builder.addIntegerOption((o) => {
        o.setName(option.name).setDescription(option.description);
        localizeDescription(o, key, option.descriptionLocalizations);
        if (option.required !== undefined) o.setRequired(option.required);
        if (option.minValue !== undefined) o.setMinValue(option.minValue);
        if (option.maxValue !== undefined) o.setMaxValue(option.maxValue);
        return o;
      });
      return;
    case "boolean":
      builder.addBooleanOption((o) => {
        o.setName(option.name).setDescription(option.description);
        localizeDescription(o, key, option.descriptionLocalizations);
        if (option.required !== undefined) o.setRequired(option.required);
        return o;
      });
      return;
    case "channel":
      builder.addChannelOption((o) => {
        o.setName(option.name).setDescription(option.description);
        localizeDescription(o, key, option.descriptionLocalizations);
        if (option.required !== undefined) o.setRequired(option.required);
        // Announcement channels are still normal sendable text channels
        // (NewsChannel is text-based, .send() works the same way) — they
        // were previously excluded from the picker entirely, which hid
        // real channels (e.g. an announcements channel) from every command
        // using this option.
        if (option.guildTextOnly) o.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement);
        if (option.voiceOnly) o.addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice);
        return o;
      });
      return;
    case "role":
      builder.addRoleOption((o) => {
        o.setName(option.name).setDescription(option.description);
        localizeDescription(o, key, option.descriptionLocalizations);
        if (option.required !== undefined) o.setRequired(option.required);
        return o;
      });
      return;
    case "user":
      builder.addUserOption((o) => {
        o.setName(option.name).setDescription(option.description);
        localizeDescription(o, key, option.descriptionLocalizations);
        if (option.required !== undefined) o.setRequired(option.required);
        return o;
      });
      return;
    case "attachment":
      builder.addAttachmentOption((o) => {
        o.setName(option.name).setDescription(option.description);
        localizeDescription(o, key, option.descriptionLocalizations);
        if (option.required !== undefined) o.setRequired(option.required);
        return o;
      });
      return;
  }
}

function addSubcommand(
  builder: SlashCommandBuilder | SlashCommandSubcommandGroupBuilder,
  subcommand: SubcommandMetadata,
  parentPath: readonly string[],
): void {
  const path = [...parentPath, subcommand.name];
  builder.addSubcommand((sub) => {
    sub.setName(subcommand.name).setDescription(subcommand.description);
    localizeDescription(sub, commandDescriptionKey(path), subcommand.descriptionLocalizations);
    for (const option of subcommand.options ?? []) addOption(sub, option, path);
    return sub;
  });
}

function addSubcommandGroup(
  builder: SlashCommandBuilder,
  group: SubcommandGroupMetadata,
  parentPath: readonly string[],
): void {
  const path = [...parentPath, group.name];
  builder.addSubcommandGroup((g) => {
    g.setName(group.name).setDescription(group.description);
    localizeDescription(g, commandDescriptionKey(path), group.descriptionLocalizations);
    for (const subcommand of group.subcommands) addSubcommand(g, subcommand, path);
    return g;
  });
}

// Converts application-layer command metadata into a live discord.js
// builder, for registration/deploy (CommandRegistry.toApplicationCommandData)
// — the one place a real SlashCommandBuilder is still needed.
export function buildSlashCommandBuilder(metadata: ChatInputCommandMetadata): SlashCommandBuilder {
  const builder = new SlashCommandBuilder()
    .setName(metadata.name)
    .setDescription(metadata.description);
  const path = [metadata.name];
  localizeDescription(builder, commandDescriptionKey(path), metadata.descriptionLocalizations);
  if (metadata.dmPermission !== undefined) builder.setDMPermission(metadata.dmPermission);
  if (metadata.nsfw !== undefined) builder.setNSFW(metadata.nsfw);
  for (const option of metadata.options ?? []) addOption(builder, option, path);
  for (const subcommand of metadata.subcommands ?? []) addSubcommand(builder, subcommand, path);
  for (const group of metadata.subcommandGroups ?? []) addSubcommandGroup(builder, group, path);
  return builder;
}

export function buildMessageContextMenuCommandBuilder(
  metadata: MessageContextMenuCommandMetadata,
): ContextMenuCommandBuilder {
  const builder = new ContextMenuCommandBuilder()
    .setName(metadata.name)
    .setType(ApplicationCommandType.Message);
  if (metadata.dmPermission !== undefined) builder.setDMPermission(metadata.dmPermission);
  return builder;
}
