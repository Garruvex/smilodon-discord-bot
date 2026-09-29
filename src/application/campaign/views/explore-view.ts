import type { AdventureBible, BibleNpc } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { Skill } from "../../../domain/campaign/character/character-sheet.js";
import type { CharacterId } from "../../../domain/campaign/core/ids.js";
import type { Glossary, SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import type { ContentId } from "../../../domain/campaign/rules/content-id.js";
import { lootGold, type HouseRules } from "../../../domain/campaign/rules/house-rules.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";

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

export interface ExploreView {
  readonly npcs: readonly ExploreNpc[];
  readonly spells: readonly ExploreSpell[];
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
  return (scene?.npcIds ?? []).flatMap((id) => bible.npcs.filter((npc) => npc.id === id));
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
  const known = state.characters[characterId]?.spellcasting?.spells ?? [];
  return known.flatMap((id) => {
    const spell = content.find(id);
    if (spell?.kind !== "spell" || (spell.level !== 0 && spell.ritual !== true)) return [];
    return [{ id, name: glossary.names[id] ?? id, cantrip: spell.level === 0 }];
  });
}

export function buildExploreView(state: CampaignState, bible: AdventureBible, content: SealedContent, glossary: Glossary, characterId: CharacterId): ExploreView {
  return { npcs: sceneNpcs(state, bible).map((npc) => exploreNpc(state, npc)), spells: castableSpells(state, characterId, content, glossary) };
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
