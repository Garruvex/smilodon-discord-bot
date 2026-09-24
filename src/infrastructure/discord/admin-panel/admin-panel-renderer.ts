import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  RoleSelectMenuBuilder,
  SectionBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import type { PanelControl, PanelOption, PanelRow, PanelSectionLayout, PanelSettingRow } from "../settings/panel-layout.js";
import { encodeAdminPanelId } from "./admin-panel-ids.js";
import type { AdminPanelText } from "./admin-panel-text.js";

export interface AdminPanelPayload {
  components: ContainerBuilder[];
  flags: MessageFlags.IsComponentsV2;
  allowedMentions: { parse: [] };
}

export interface AdminPanelLastChange {
  summary: string;
  userId: string;
  at: Date;
}

// Discord's caps on the pieces rendered here.
const selectLabelLimit = 100;
const selectDescriptionLimit = 100;
const modalTitleLimit = 45;
const modalLabelLimit = 45;
const modalDescriptionLimit = 100;
const reportLimit = 1500;
const maxSelectValues = 25;

const textChannelTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function accentColor(embedColor: string): number {
  const parsed = Number.parseInt(embedColor.replace(/^#/, ""), 16);
  return Number.isNaN(parsed) ? 0x3b82f6 : parsed;
}

function payload(container: ContainerBuilder): AdminPanelPayload {
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

export function renderAdminPanelHeader(input: {
  text: AdminPanelText;
  embedColor: string;
  lastChange: AdminPanelLastChange | null;
  everyoneCanView: boolean;
}): AdminPanelPayload {
  const { ui } = input.text;
  const lines = [`# ${ui.header.title}`, ui.header.intro];
  if (input.lastChange) {
    lines.push(`-# ${ui.header.lastChange({
      change: input.lastChange.summary,
      user: `<@${input.lastChange.userId}>`,
      time: `<t:${Math.floor(input.lastChange.at.getTime() / 1000)}:t>`,
    })}`);
  }
  if (input.everyoneCanView) lines.push(ui.header.everyoneCanView);

  const container = new ContainerBuilder()
    .setAccentColor(accentColor(input.embedColor))
    .addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
      .setButtonAccessory(new ButtonBuilder()
        .setCustomId(encodeAdminPanelId({ kind: "refresh" }))
        .setStyle(ButtonStyle.Secondary)
        .setLabel(ui.header.refresh)));
  return payload(container);
}

// `reports` holds each report row's rendered text, keyed by setting name —
// report settings run async (audit log fetch, checkpoint store), so the
// service resolves them before rendering.
export function renderAdminPanelSection(input: {
  section: PanelSectionLayout;
  profile: GuildConfiguration;
  text: AdminPanelText;
  reports: ReadonlyMap<string, string>;
}): AdminPanelPayload {
  const { section, profile, text } = input;
  const container = new ContainerBuilder()
    .setAccentColor(accentColor(profile.embedColor))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `## ${text.sectionTitle(section)}\n-# ${text.groupDescription(section, section.description)}`,
    ));

  for (const row of section.rows) renderRow(container, section, row, profile, text, input.reports);

  if (section.rows.some((row) => row.kind === "setting" && hasSlashOnlyOptions(row))) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
      `-# ${text.ui.slashOnly({ command: `/settings-${section.groupName}` })}`,
    ));
  }
  return payload(container);
}

function hasSlashOnlyOptions(row: PanelSettingRow): boolean {
  return (row.setting.configureOptions?.() ?? []).some((option) => !option.panel);
}

function renderRow(
  container: ContainerBuilder,
  section: PanelSectionLayout,
  row: PanelRow,
  profile: GuildConfiguration,
  text: AdminPanelText,
  reports: ReadonlyMap<string, string>,
): void {
  if (row.kind === "report") {
    const report = reports.get(row.setting.name);
    if (report) container.addTextDisplayComponents(new TextDisplayBuilder().setContent(truncate(report, reportLimit)));
    return;
  }

  for (const control of row.controls) renderControl(container, row, control, profile, text);

  if (row.modalFields.length > 0) {
    const lines = row.modalFields.map((option) =>
      `**${text.label(option.panel.label)}:** ${formatValue(option, option.panel.read(profile), text)}`);
    container.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
      .setButtonAccessory(new ButtonBuilder()
        .setCustomId(encodeAdminPanelId({ kind: "edit", section: section.name, setting: row.setting.name }))
        .setStyle(ButtonStyle.Secondary)
        .setLabel(text.ui.edit)));
  }
}

function rowHeading(row: PanelSettingRow, option: { name: string; description: string; panel: { label: string } }, text: AdminPanelText): string {
  const description = text.optionDescription(row.groupName, row.setting.name, option.name, option.description);
  return `**${text.label(option.panel.label)}**\n-# ${description}`;
}

function renderControl(
  container: ContainerBuilder,
  row: PanelSettingRow,
  control: PanelControl,
  profile: GuildConfiguration,
  text: AdminPanelText,
): void {
  const setting = row.setting.name;
  const option = control.option.name;

  switch (control.kind) {
    case "toggle": {
      const on = control.option.panel.read(profile) === true;
      container.addSectionComponents(new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(rowHeading(row, control.option, text)))
        .setButtonAccessory(new ButtonBuilder()
          .setCustomId(encodeAdminPanelId({ kind: "toggle", setting, option, value: !on }))
          .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setLabel(on ? text.ui.toggle.on : text.ui.toggle.off)));
      return;
    }
    case "choice": {
      // The select labels itself ("When the queue ends: Disconnect") instead
      // of taking a text line above it — a message only fits 40 components.
      const current = control.option.panel.read(profile);
      const label = text.label(control.option.panel.label);
      const description = text.optionDescription(row.groupName, setting, option, control.option.description);
      const choices = control.option.type === "string" ? (control.option.choices ?? []) : [];
      container.addActionRowComponents(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(encodeAdminPanelId({ kind: "choice", setting, option }))
          .setPlaceholder(truncate(label, selectLabelLimit))
          .addOptions(choices.map((choice) => ({
            label: truncate(`${label}: ${choice.name}`, selectLabelLimit),
            value: choice.value,
            description: truncate(description, selectDescriptionLimit),
            default: choice.value === current,
          }))),
      ));
      return;
    }
    case "channel":
    case "role": {
      const current = control.option.panel.read(profile);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(rowHeading(row, control.option, text)));
      const customId = encodeAdminPanelId({ kind: control.kind, setting, option });
      const picker = control.kind === "channel"
        ? channelPicker(customId, control.option.type === "channel" && control.option.guildTextOnly === true, typeof current === "string" ? [current] : [], 1)
        : new RoleSelectMenuBuilder().setCustomId(customId).setMinValues(1).setMaxValues(1)
          .setDefaultRoles(typeof current === "string" ? [current] : []);
      picker.setPlaceholder(text.ui.notSet);
      container.addActionRowComponents(
        new ActionRowBuilder<ChannelSelectMenuBuilder | RoleSelectMenuBuilder>().addComponents(picker),
      );
      return;
    }
    case "list": {
      const current = control.option.panel.read(profile).slice(0, maxSelectValues);
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(rowHeading(row, control.option, text)));
      const customId = encodeAdminPanelId({ kind: "list", setting, option });
      const picker = control.option.type === "channelList"
        ? channelPicker(customId, control.option.guildTextOnly === true, current, maxSelectValues).setMinValues(0)
        : new RoleSelectMenuBuilder().setCustomId(customId).setMinValues(0).setMaxValues(maxSelectValues)
          .setDefaultRoles([...current]);
      picker.setPlaceholder(text.ui.notSet);
      container.addActionRowComponents(
        new ActionRowBuilder<ChannelSelectMenuBuilder | RoleSelectMenuBuilder>().addComponents(picker),
      );
      return;
    }
  }
}

function channelPicker(
  customId: string,
  guildTextOnly: boolean,
  current: readonly string[],
  maxValues: number,
): ChannelSelectMenuBuilder {
  const picker = new ChannelSelectMenuBuilder()
    .setCustomId(customId)
    .setMinValues(1)
    .setMaxValues(maxValues)
    .setDefaultChannels([...current]);
  if (guildTextOnly) picker.setChannelTypes(...textChannelTypes);
  return picker;
}

export function formatValue(option: PanelOption, value: string | number | boolean | null, text: AdminPanelText): string {
  if (value === null) return text.ui.notSet;
  if (typeof value === "boolean") return value ? text.ui.toggle.on : text.ui.toggle.off;
  switch (option.type) {
    case "channel":
      return `<#${String(value)}>`;
    case "role":
      return `<@&${String(value)}>`;
    case "string":
      return option.choices?.find((choice) => choice.value === value)?.name ?? String(value);
    default:
      return String(value);
  }
}

// The modal behind a row's Edit button: one text field per integer or
// free-text option, pre-filled with its current value.
export function renderAdminPanelModal(
  section: PanelSectionLayout,
  row: PanelSettingRow,
  profile: GuildConfiguration,
  text: AdminPanelText,
): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(encodeAdminPanelId({ kind: "modal", section: section.name, setting: row.setting.name }))
    .setTitle(truncate(text.ui.modal.title({ setting: row.setting.name }), modalTitleLimit));

  for (const option of row.modalFields) {
    const current = option.panel.read(profile);
    const input = new TextInputBuilder()
      .setCustomId(option.name)
      .setStyle(option.type === "string" && (option.maxLength ?? 0) > 100 ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(false);
    if (current !== null) input.setValue(String(current));
    if (option.type === "string" && option.maxLength) input.setMaxLength(option.maxLength);
    const description = text.optionDescription(row.groupName, row.setting.name, option.name, option.description);
    modal.addLabelComponents(new LabelBuilder()
      .setLabel(truncate(text.label(option.panel.label), modalLabelLimit))
      .setDescription(truncate(description, modalDescriptionLimit))
      .setTextInputComponent(input));
  }
  return modal;
}
