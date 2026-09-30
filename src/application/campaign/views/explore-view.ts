import type { AdventureBible, BibleNpc } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { Skill } from "../../../domain/campaign/character/character-sheet.js";
import type { CharacterId } from "../../../domain/campaign/core/ids.js";
import type { Glossary, SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import type { ContentId } from "../../../domain/campaign/rules/content-id.js";
import { lootGold, type HouseRules } from "../../../domain/campaign/rules/house-rules.js";
import { abilityModifier } from "../../../domain/campaign/character/character-sheet.js";
import { defaultHeroResources } from "../../../domain/campaign/character/hero-status.js";
import { knownSpells, spellbookOf } from "../../../domain/campaign/character/spell-access.js";
import { reviveEffectOf } from "../../../domain/campaign/engine/revival-magic.js";
import { companionEffectOf } from "../../../domain/campaign/engine/companion-magic.js";
import { healingEffectOf } from "../../../domain/campaign/engine/healing-magic.js";
import { castableSlotLevels, mergeSlots } from "../../../domain/campaign/magic/spell-rules.js";
import { isFallen, type CampaignState } from "../../../domain/campaign/state/campaign-state.js";

// What a hero can do between fights, read straight off the saved game and the
// adventure (panel spec, Explore): the people in the scene they are standing
// in, the spells they can cast without a slot, and — for one of those people
// who trades — what is for sale, what they will buy, and what the hero can
// pay. Nothing here is stored; it is rebuilt at every click.

export interface ExploreNpc {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly trades: boolean;
  // Their secret was already won: pressing them again is refused.
  readonly secretKnown: boolean;
}

export interface ExploreSpell {
  readonly id: ContentId<"spell">;
  readonly name: string;
  readonly cantrip: boolean;
}

// A spell that heals a friend, with the slot levels the hero can still cast it at.
export interface HealingSpell {
  readonly id: ContentId<"spell">;
  readonly name: string;
  readonly slots: readonly { readonly level: number; readonly left: number }[];
}

export interface HurtHero {
  readonly id: CharacterId;
  readonly name: string;
  readonly hp: number;
  readonly maxHp: number;
}

export interface ExploreView {
  readonly npcs: readonly ExploreNpc[];
  readonly spells: readonly ExploreSpell[];
  // Healing spells the hero can cast now (a slot is left), and the friends who are hurt.
  readonly healing: readonly HealingSpell[];
  // Spells that call creatures to wait for the next fight, with the slots the hero can cast them at.
  readonly conjuring: readonly HealingSpell[];
  // Spells that bring back a fallen hero, with the slots to cast them at, and the heroes who have fallen.
  readonly reviving: readonly HealingSpell[];
  readonly fallen: readonly { readonly id: CharacterId; readonly name: string }[];
  readonly hurt: readonly HurtHero[];
}

export interface ShopLine {
  readonly itemId: ContentId<"item">;
  readonly name: string;
  readonly price: number;
}

export interface ShopView {
  readonly npc: ExploreNpc;
  // What the hero can spend: the party purse, or their own share when gold is split.
  readonly gold: number;
  readonly wallet: "pool" | "hero";
  readonly buy: readonly ShopLine[];
  // What the hero carries that this shop would buy.
  readonly sell: readonly ShopLine[];
}

// The skills the engine accepts for pressing an NPC or haggling, in the order a menu offers them.
export const pressSkills: readonly Skill[] = ["insight", "persuasion", "deception", "intimidation"];
export const haggleSkills: readonly Skill[] = ["persuasion", "deception", "intimidation"];

// The NPCs the party can reach: those the current scene lists.
export function sceneNpcs(state: CampaignState, bible: AdventureBible): readonly BibleNpc[] {
  const scene = bible.scenes.find((candidate) => candidate.id === state.sceneId);
  return (scene?.npcIds ?? []).filter((id) => state.npcsDown?.includes(id) !== true).flatMap((id) => bible.npcs.filter((npc) => npc.id === id));
}

function exploreNpc(state: CampaignState, npc: BibleNpc): ExploreNpc {
  return {
    id: npc.id,
    name: npc.name,
    description: npc.publicDescription,
    trades: npc.shop !== undefined,
    secretKnown: state.npcSecretsRevealed?.[npc.id] === true,
  };
}

// A spell cast outside a fight must be a cantrip or a ritual the hero knows.
export function castableSpells(state: CampaignState, characterId: CharacterId, content: SealedContent, glossary: Glossary): readonly ExploreSpell[] {
  const sheet = state.characters[characterId];
  const known = sheet === undefined ? [] : knownSpells(sheet, content);
  return known.flatMap((id) => {
    const spell = content.find(id);
    if (spell?.kind !== "spell" || (spell.level !== 0 && spell.ritual !== true)) return [];
    return [{ id, name: glossary.names[id] ?? id, cantrip: spell.level === 0 }];
  });
}

// Healing spells the hero knows and has a slot for: what the engine's own
// healingEffectOf accepts, at each slot level the hero still holds.
export function healingSpells(state: CampaignState, characterId: CharacterId, content: SealedContent, glossary: Glossary): readonly HealingSpell[] {
  const sheet = state.characters[characterId];
  if (sheet?.spellcasting === null || sheet === undefined) return [];
  const resources = state.heroStatus[characterId]?.resources ?? defaultHeroResources(sheet, content);
  const slots = mergeSlots(resources.spellSlots, resources.pactSlots ?? {});
  const modifier = abilityModifier(sheet.abilityScores[sheet.spellcasting.ability]);
  return spellbookOf(sheet, content).flatMap((id) => {
    const spell = content.find(id);
    if (spell?.kind !== "spell" || healingEffectOf(spell, spell.level, sheet.level, modifier) === undefined) return [];
    const levels = castableSlotLevels(spell, slots).map((level) => ({ level, left: slots[level] ?? 0 }));
    return levels.length === 0 ? [] : [{ id, name: glossary.names[id] ?? id, slots: levels }];
  });
}

// Spells that call creatures to join the next fight (a ritual one is already among castableSpells), at each slot level still held.
export function conjuringSpells(state: CampaignState, characterId: CharacterId, content: SealedContent, glossary: Glossary): readonly HealingSpell[] {
  const sheet = state.characters[characterId];
  if (sheet?.spellcasting === null || sheet === undefined) return [];
  const resources = state.heroStatus[characterId]?.resources ?? defaultHeroResources(sheet, content);
  const slots = mergeSlots(resources.spellSlots, resources.pactSlots ?? {});
  return knownSpells(sheet, content).flatMap((id) => {
    const spell = content.find(id);
    if (spell?.kind !== "spell" || spell.ritual === true || companionEffectOf(spell) === undefined) return [];
    const levels = castableSlotLevels(spell, slots).map((level) => ({ level, left: slots[level] ?? 0 }));
    return levels.length === 0 ? [] : [{ id, name: glossary.names[id] ?? id, slots: levels }];
  });
}

// Spells that bring a fallen hero back, at each slot level still held; none while no one has fallen.
export function revivingSpells(state: CampaignState, characterId: CharacterId, content: SealedContent, glossary: Glossary): readonly HealingSpell[] {
  const sheet = state.characters[characterId];
  if (sheet?.spellcasting === null || sheet === undefined || fallenHeroes(state).length === 0) return [];
  const resources = state.heroStatus[characterId]?.resources ?? defaultHeroResources(sheet, content);
  const slots = mergeSlots(resources.spellSlots, resources.pactSlots ?? {});
  return knownSpells(sheet, content).flatMap((id) => {
    const spell = content.find(id);
    if (spell?.kind !== "spell" || reviveEffectOf(spell) === undefined) return [];
    const levels = castableSlotLevels(spell, slots).map((level) => ({ level, left: slots[level] ?? 0 }));
    return levels.length === 0 ? [] : [{ id, name: glossary.names[id] ?? id, slots: levels }];
  });
}

export function fallenHeroes(state: CampaignState): readonly { readonly id: CharacterId; readonly name: string }[] {
  return Object.values(state.characters).filter((sheet) => isFallen(state, sheet.id)).map((sheet) => ({ id: sheet.id, name: sheet.name }));
}

export function hurtHeroes(state: CampaignState): readonly HurtHero[] {
  return Object.values(state.characters).flatMap((sheet) => {
    const hp = state.heroStatus[sheet.id]?.hp ?? sheet.maxHp;
    return isFallen(state, sheet.id) || hp >= sheet.maxHp ? [] : [{ id: sheet.id, name: sheet.name, hp: Math.max(0, hp), maxHp: sheet.maxHp }];
  });
}

export function buildExploreView(state: CampaignState, bible: AdventureBible, content: SealedContent, glossary: Glossary, characterId: CharacterId): ExploreView {
  return {
    npcs: sceneNpcs(state, bible).map((npc) => exploreNpc(state, npc)),
    spells: castableSpells(state, characterId, content, glossary),
    healing: healingSpells(state, characterId, content, glossary),
    conjuring: conjuringSpells(state, characterId, content, glossary),
    reviving: revivingSpells(state, characterId, content, glossary),
    fallen: fallenHeroes(state),
    hurt: hurtHeroes(state),
  };
}

export function buildShopView(state: CampaignState, bible: AdventureBible, glossary: Glossary, houseRules: HouseRules, characterId: CharacterId, npcId: string): ShopView | undefined {
  const npc = sceneNpcs(state, bible).find((candidate) => candidate.id === npcId);
  if (npc?.shop === undefined) return undefined;
  const nameOf = (id: string): string => glossary.names[id] ?? id;
  const split = houseRules.option(lootGold) === "split";
  const held = [...new Set(state.characters[characterId]?.equipment ?? [])];
  return {
    npc: exploreNpc(state, npc),
    gold: split ? (state.heroGold?.[characterId] ?? 0) : state.gold,
    wallet: split ? "hero" : "pool",
    buy: npc.shop.stock.map((entry) => ({ itemId: entry.itemId, name: nameOf(entry.itemId), price: entry.buyPrice })),
    sell: held.flatMap((itemId) => {
      const entry = npc.shop?.stock.find((candidate) => candidate.itemId === itemId);
      return entry?.sellPrice === undefined ? [] : [{ itemId, name: nameOf(itemId), price: entry.sellPrice }];
    }),
  };
}
