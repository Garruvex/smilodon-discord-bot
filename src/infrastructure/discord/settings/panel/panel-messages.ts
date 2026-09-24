import {
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";

import type { SettingsText } from "../../../../application/i18n/settings/index.js";
import type { Texts } from "../../../../application/i18n/texts.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import type { RegisteredNode } from "../registry/paths.js";
import type { ControlIds } from "./control-ids.js";
import { renderNodeBlock, type RowBlock } from "./node-rows.js";

export interface PanelPayload {
  components: ContainerBuilder[];
  flags: MessageFlags.IsComponentsV2;
  allowedMentions: { parse: [] };
}

// One message's worth of a section (or of a flat group, which is its own
// section): `key` identifies it for editing in place later.
export interface PanelMessage {
  key: string;
  payload: PanelPayload;
}

// A section, or a group registered without sections.
export interface PanelUnit {
  key: string;
  groupName: string;
  sectionPath: string | null;
  nodes: readonly RegisteredNode[];
}

export interface PanelLastChange {
  summary: string;
  userId: string;
  at: Date;
}

// Discord's per-message limits for Components V2.
export const maxComponents = 40;
export const maxCharacters = 4000;

export function panelUnits(nodes: readonly RegisteredNode[]): PanelUnit[] {
  const units: PanelUnit[] = [];
  for (const node of nodes) {
    const sectionPath = node.section ? `${node.group.name}.${node.section.name}` : null;
    const key = sectionPath ?? node.group.name;
    const unit = units.find((candidate) => candidate.key === key);
    if (unit) (unit.nodes as RegisteredNode[]).push(node);
    else units.push({ key, groupName: node.group.name, sectionPath, nodes: [node] });
  }
  return units;
}

export function accentColor(embedColor: string): number {
  const parsed = Number.parseInt(embedColor.replace(/^#/, ""), 16);
  return Number.isNaN(parsed) ? 0x3b82f6 : parsed;
}

function payloadOf(container: ContainerBuilder): PanelPayload {
  return { components: [container], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

export interface UnitContext {
  profile: GuildConfiguration;
  text: SettingsText;
  ui: Texts;
  ids: ControlIds;
  // Rendered report text by node path.
  reports: ReadonlyMap<string, string>;
}

// A unit's messages: `## Group · Section` and its rows, divided between
// nodes, packed into as many messages as Discord's limits need.
export function renderUnitMessages(unit: PanelUnit, context: UnitContext): PanelMessage[] {
  const title = unit.sectionPath
    ? `${context.text.title(unit.groupName)} · ${context.text.title(unit.sectionPath)}`
    : context.text.title(unit.groupName);
  const description = context.text.description(unit.sectionPath ?? unit.groupName);

  const parts: { container: ContainerBuilder; components: number; characters: number; rows: number }[] = [];
  const startPart = (): (typeof parts)[number] => {
    const heading = parts.length === 0
      ? `## ${title}\n-# ${description}`
      : `## ${context.ui.admin.panel.continued({ title })}`;
    const part = {
      container: new ContainerBuilder()
        .setAccentColor(accentColor(context.profile.embedColor))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(heading)),
      components: 2,
      characters: heading.length,
      rows: 0,
    };
    parts.push(part);
    return part;
  };

  let part = startPart();
  for (const registered of unit.nodes) {
    const block: RowBlock = renderNodeBlock(registered, { ...context, report: context.reports.get(registered.path) });
    const fits = (candidate: (typeof parts)[number]): boolean =>
      candidate.components + block.components + (candidate.rows > 0 ? 1 : 0) <= maxComponents &&
      candidate.characters + block.characters <= maxCharacters;
    if (!fits(part)) {
      part = startPart();
      if (!fits(part)) throw new Error(`Setting "${registered.path}" alone is too big for one panel message.`);
    }
    if (part.rows > 0) {
      part.container.addSeparatorComponents(new SeparatorBuilder());
      part.components += 1;
    }
    block.add(part.container);
    part.components += block.components;
    part.characters += block.characters;
    part.rows += 1;
  }

  return parts.map((candidate, index) => ({ key: `${unit.key}#${index}`, payload: payloadOf(candidate.container) }));
}

export function renderPanelHeader(input: {
  ui: Texts;
  embedColor: string;
  ids: ControlIds;
  lastChange: PanelLastChange | null;
  everyoneCanView: boolean;
}): PanelPayload {
  const { header } = input.ui.admin.panel;
  const lines = [`# ${header.title}`, header.intro];
  if (input.lastChange) {
    lines.push(`-# ${header.lastChange({
      change: input.lastChange.summary,
      user: `<@${input.lastChange.userId}>`,
      time: `<t:${Math.floor(input.lastChange.at.getTime() / 1000)}:t>`,
    })}`);
  }
  if (input.everyoneCanView) lines.push(header.everyoneCanView);

  return payloadOf(new ContainerBuilder()
    .setAccentColor(accentColor(input.embedColor))
    .addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join("\n")))
      .setButtonAccessory(new ButtonBuilder()
        .setCustomId(input.ids.encode({ kind: "refresh" }))
        .setStyle(ButtonStyle.Secondary)
        .setLabel(header.refresh))));
}
