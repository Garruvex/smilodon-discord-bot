import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  RoleSelectMenuBuilder,
  SectionBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  type ContainerBuilder,
} from "discord.js";

import type { SettingsText } from "../../../../application/i18n/settings/index.js";
import type { Texts } from "../../../../application/i18n/texts.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import { formatOptionValue } from "../engine/format-option-value.js";
import { optionPath, type RegisteredNode } from "../registry/paths.js";
import type { ChannelOption, ChoiceOption, ListOption, RoleOption, SettingNode, SettingOption, ToggleOption } from "../registry/types.js";
import type { ControlIds } from "./control-ids.js";

// A piece of a panel message, with what it costs against Discord's per-
// message limits (40 components, 4000 characters of text) so the layout can
// pack rows into as many messages as it needs.
export interface RowBlock {
  components: number;
  characters: number;
  add(container: ContainerBuilder): void;
}

export interface RowContext {
  profile: GuildConfiguration;
  text: SettingsText;
  ui: Texts;
  ids: ControlIds;
  // A report node's rendered text.
  report?: string | undefined;
}

// Discord's caps on the pieces rendered here.
const buttonLabelLimit = 80;
const selectTextLimit = 100;
const reportLimit = 1500;
const maxSelectValues = 25;
const textChannelTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

export function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

// Options edited in the node's form rather than by an inline control.
export function formOptionsOf(node: SettingNode): [string, SettingOption][] {
  return Object.entries(node.options).filter(([, option]) =>
    option.kind === "integer" || option.kind === "text" || option.kind === "upload");
}

// One node's row: a setting's controls, an action's button, a report's text.
export function renderNodeBlock(registered: RegisteredNode, context: RowContext): RowBlock {
  const parts: RowBlock[] = [];
  const { node, path } = registered;
  const heading = `**${context.text.label(path)}**\n-# ${context.text.description(path)}`;

  switch (node.kind) {
    case "report":
      parts.push(textBlock(truncate(`-# ${context.text.description(path)}\n${context.report ?? ""}`, reportLimit)));
      break;

    case "action":
      parts.push(sectionBlock(heading, new ButtonBuilder()
        .setCustomId(context.ids.encode({ kind: "run", path }))
        .setStyle(node.confirm ? ButtonStyle.Danger : ButtonStyle.Secondary)
        .setLabel(truncate(context.ui.admin.panel.run, buttonLabelLimit))));
      break;

    case "setting": {
      const entries = Object.entries(node.options);
      const [only] = entries;
      // A single toggle is the whole row: heading and switch together.
      if (entries.length === 1 && only?.[1].kind === "toggle") {
        parts.push(sectionBlock(heading, toggleButton(path, only[0], only[1], context)));
        break;
      }
      parts.push(textBlock(heading));
      for (const [name, option] of entries) {
        const control = renderControl(path, name, option, context);
        if (control) parts.push(control);
      }
      const formOptions = formOptionsOf(node);
      if (formOptions.length > 0) {
        const lines = formOptions.map(([name, option]) => {
          const key = optionPath(path, name);
          return `${context.text.label(key)}: ${formatOptionValue(option, key, option.read(context.profile), context.text, context.ui.settings)}`;
        });
        parts.push(sectionBlock(lines.join("\n"), new ButtonBuilder()
          .setCustomId(context.ids.encode({ kind: "edit", path }))
          .setStyle(ButtonStyle.Secondary)
          .setLabel(context.ui.admin.panel.edit)));
      }
      break;
    }
  }

  return {
    components: parts.reduce((sum, part) => sum + part.components, 0),
    characters: parts.reduce((sum, part) => sum + part.characters, 0),
    add: (container): void => {
      for (const part of parts) part.add(container);
    },
  };
}

function renderControl(path: string, name: string, option: SettingOption, context: RowContext): RowBlock | null {
  const key = optionPath(path, name);
  switch (option.kind) {
    case "toggle":
      return sectionBlock(
        `**${context.text.label(key)}**\n-# ${context.text.description(key)}`,
        toggleButton(path, name, option, context),
      );
    case "choice":
      return rowBlock(choiceSelect(path, name, option, context));
    case "channel":
    case "role":
    case "channelList":
    case "roleList":
      return withLabel(`**${context.text.label(key)}**\n-# ${context.text.description(key)}`, picker(path, name, option, context));
    case "integer":
    case "text":
    case "upload":
      return null;
  }
}

function toggleButton(path: string, name: string, option: ToggleOption, context: RowContext): ButtonBuilder {
  const on = option.read(context.profile) === true;
  return new ButtonBuilder()
    .setCustomId(context.ids.encode({ kind: "toggle", path, option: name, value: !on }))
    .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary)
    .setLabel(on ? context.ui.settings.value.on : context.ui.settings.value.off);
}

// The select labels itself ("When the queue ends: Disconnect") instead of
// taking a text line above it, which saves a component per choice.
function choiceSelect(path: string, name: string, option: ChoiceOption, context: RowContext): StringSelectMenuBuilder {
  const key = optionPath(path, name);
  const label = context.text.label(key);
  const current = option.read(context.profile);
  return new StringSelectMenuBuilder()
    .setCustomId(context.ids.encode({ kind: "choice", path, option: name }))
    .setPlaceholder(truncate(label, selectTextLimit))
    .addOptions(option.choices.map((value) => ({
      label: truncate(`${label}: ${context.text.choice(key, value)}`, selectTextLimit),
      value,
      description: truncate(context.text.description(key), selectTextLimit),
      default: value === current,
    })));
}

function picker(
  path: string,
  name: string,
  option: ChannelOption | RoleOption | ListOption,
  context: RowContext,
): ChannelSelectMenuBuilder | RoleSelectMenuBuilder {
  const current = option.read(context.profile);
  const selected = typeof current === "string" ? [current] : current === null ? [] : current.slice(0, maxSelectValues);
  const isList = option.kind === "channelList" || option.kind === "roleList";
  const minValues = isList || (option.kind === "channel" && option.clearable) ? 0 : 1;
  const maxValues = isList ? maxSelectValues : 1;

  if (option.kind === "channel" || option.kind === "channelList") {
    const select = new ChannelSelectMenuBuilder()
      .setCustomId(context.ids.encode({ kind: option.kind === "channel" ? "channel" : "list", path, option: name }))
      .setMinValues(minValues)
      .setMaxValues(maxValues)
      .setDefaultChannels(...selected)
      .setPlaceholder(context.ui.settings.value.notSet);
    if (option.textOnly) select.setChannelTypes(...textChannelTypes);
    return select;
  }
  return new RoleSelectMenuBuilder()
    .setCustomId(context.ids.encode({ kind: option.kind === "role" ? "role" : "list", path, option: name }))
    .setMinValues(minValues)
    .setMaxValues(maxValues)
    .setDefaultRoles(...selected)
    .setPlaceholder(context.ui.settings.value.notSet);
}

function textBlock(content: string): RowBlock {
  return {
    components: 1,
    characters: content.length,
    add: (container) => container.addTextDisplayComponents(new TextDisplayBuilder().setContent(content)),
  };
}

// Section + text + accessory button.
function sectionBlock(content: string, button: ButtonBuilder): RowBlock {
  return {
    components: 3,
    characters: content.length,
    add: (container) => container.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(content))
      .setButtonAccessory(button)),
  };
}

// Action row + one select.
function rowBlock(select: StringSelectMenuBuilder | ChannelSelectMenuBuilder | RoleSelectMenuBuilder): RowBlock {
  return {
    components: 2,
    characters: 0,
    add: (container) => container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder | ChannelSelectMenuBuilder | RoleSelectMenuBuilder>().addComponents(select),
    ),
  };
}

function withLabel(content: string, select: ChannelSelectMenuBuilder | RoleSelectMenuBuilder): RowBlock {
  const label = textBlock(content);
  const row = rowBlock(select);
  return {
    components: label.components + row.components,
    characters: label.characters,
    add: (container): void => {
      label.add(container);
      row.add(container);
    },
  };
}
