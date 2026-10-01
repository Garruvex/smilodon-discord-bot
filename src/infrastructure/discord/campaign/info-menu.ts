import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";

import type { Texts } from "../../../application/i18n/texts.js";
import type { CharacterSheet } from "../../../domain/campaign/character/character-sheet.js";
import type { Glossary, SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import { campaignCustomId } from "./campaign-ids.js";
import { describeContent } from "./content-info.js";

const maxOptions = 25;

// Everything on a hero that has a stats screen: spells first, then what is
// carried, then features. Each id once, and no more than a menu can hold.
export function inspectableIds(sheet: CharacterSheet): readonly string[] {
  const ids = [...(sheet.spellcasting?.spells ?? []), ...sheet.equipment, ...sheet.features];
  return [...new Set<string>(ids)].slice(0, maxOptions);
}

// The "look up" menu for one hero; null when there is nothing to look up.
export function inspectMenu(
  sheet: CharacterSheet,
  glossary: Glossary,
  text: Texts,
  campaignId: string,
): { readonly content: string; readonly row: ActionRowBuilder<StringSelectMenuBuilder> } | null {
  const ids = inspectableIds(sheet);
  if (ids.length === 0) return null;
  const options = ids.map((id) => ({ label: (glossary.names[id] ?? id).slice(0, 100), value: id }));
  return {
    content: text.campaign.info.prompt({ hero: sheet.name }),
    row: new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(campaignCustomId("inspectPick", campaignId, sheet.id)).setPlaceholder(text.campaign.info.placeholder).addOptions(options),
    ),
  };
}

// The stats screen for one pick, or a note that the hero no longer has it.
export function inspectText(sheet: CharacterSheet, id: string, content: SealedContent, glossary: Glossary, text: Texts): string {
  if (!inspectableIds(sheet).includes(id)) return text.campaign.info.gone;
  const definition = content.find(id);
  const count = sheet.equipment.filter((owned) => owned === id).length;
  return (definition === undefined ? null : describeContent(definition, { text, nameOf: (key) => glossary.names[key] ?? key, level: sheet.level, count })) ?? text.campaign.info.gone;
}
