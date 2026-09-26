import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";

import type { Texts } from "../../../application/i18n/texts.js";
import { isWorn } from "../../../domain/campaign/combat/combatant-profile.js";
import { potionFor } from "../../../domain/campaign/engine/potions.js";
import type { ContentId } from "../../../domain/campaign/rules/content-id.js";
import type { Glossary, SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import { isFallen, type CampaignState } from "../../../domain/campaign/state/campaign-state.js";
import { campaignCustomId } from "./campaign-ids.js";

// The pack menu on My Hero (private): drink a potion, put an item in the party
// stash or take one out, or give an item to another hero, who accepts it in
// the Party channel. Outside fights only. Choices are written into the option
// values and checked again by the engine.

export type PackVerb = "use" | "stash" | "take" | "give";

export interface PackChoice {
  readonly verb: PackVerb;
  readonly item: ContentId<"item">;
}

const maxOptions = 25;

export function parsePackChoice(value: string): PackChoice | null {
  const [verb, item] = value.split("|");
  if ((verb !== "use" && verb !== "stash" && verb !== "take" && verb !== "give") || item === undefined || !item.startsWith("item:")) return null;
  return { verb, item: item as ContentId<"item"> };
}

// "<item>><hero>": who a gift goes to.
export function parseGift(value: string): { readonly item: ContentId<"item">; readonly toCharacterId: string } | null {
  const split = value.lastIndexOf(">");
  const item = value.slice(0, split);
  const toCharacterId = value.slice(split + 1);
  return split < 0 || !item.startsWith("item:") || toCharacterId.length === 0 ? null : { item: item as ContentId<"item">, toCharacterId };
}

// Empty during a fight, for a fallen hero, or when there is nothing to do.
export function packMenu(
  state: CampaignState,
  content: SealedContent,
  glossary: Glossary,
  text: Texts,
  campaignId: string,
  characterId: string,
  // The table turned item trading off: no Give.
  tradingOff = false,
): ActionRowBuilder<StringSelectMenuBuilder> | null {
  const sheet = state.characters[characterId];
  if (sheet === undefined || isFallen(state, characterId)) return null;
  if (state.encounter !== null && state.encounter.status !== "ended") return null;
  const name = (id: string): string => glossary.names[id] ?? id;
  const t = text.campaign.pack;
  // Worn armor and shields come off first, from the gear menu.
  const carried = [...new Set(sheet.equipment)].filter((id) => !(isWearable(content, id) && isWorn(sheet, content, id)));
  const others = Object.values(state.characters).some((other) => other.id !== characterId && !isFallen(state, other.id));
  const options = [
    ...carried.filter((id) => potionFor(state, content, characterId, id) !== null).map((id) => ({ label: t.use({ item: name(id) }), value: `use|${id}` })),
    ...(others && !tradingOff ? carried.map((id) => ({ label: t.give({ item: name(id) }), value: `give|${id}` })) : []),
    ...carried.map((id) => ({ label: t.stash({ item: name(id) }), value: `stash|${id}` })),
    ...[...new Set(state.stash)].map((id) => ({ label: t.take({ item: name(id) }), value: `take|${id}` })),
  ]
    .map((option) => ({ ...option, label: option.label.slice(0, 100) }))
    .slice(0, maxOptions);
  if (options.length === 0) return null;
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(campaignCustomId("pack", campaignId)).setPlaceholder(t.placeholder).addOptions(options),
  );
}

// The second step of a gift: the other living heroes.
export function giveMenu(
  state: CampaignState,
  glossary: Glossary,
  text: Texts,
  campaignId: string,
  characterId: string,
  item: ContentId<"item">,
): { readonly content: string; readonly row: ActionRowBuilder<StringSelectMenuBuilder> } | null {
  const options = Object.values(state.characters)
    .filter((other) => other.id !== characterId && !isFallen(state, other.id))
    .map((other) => ({ label: other.name.slice(0, 100), value: `${item}>${other.id}` }))
    .slice(0, maxOptions);
  if (options.length === 0) return null;
  const t = text.campaign.pack;
  return {
    content: t.givePrompt({ item: glossary.names[item] ?? item }),
    row: new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(campaignCustomId("giveTo", campaignId)).setPlaceholder(t.givePlaceholder).addOptions(options),
    ),
  };
}

function isWearable(content: SealedContent, id: ContentId<"item">): boolean {
  const definition = content.find(id);
  return definition?.kind === "item" && (definition.itemType === "armor" || definition.itemType === "shield");
}
