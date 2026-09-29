import { defineMagicItem, type ContentDefinition, type ItemDefinition, type SpellDefinition } from "../../../rules/content-definitions.js";
import type { ContentId } from "../../../rules/content-id.js";
import { srd51Cantrips } from "../spells/cantrips.js";
import { srd51Level1Spells } from "../spells/level-1.js";
import { srd51GeneratedSpells } from "../spells/srd-spells.generated.js";
import { srd51UtilitySpells } from "../spells/utility.js";

// A spell scroll for every spell that can be cast on the caster's turn. Reading it casts the spell at its own
// level whatever the reader's class, once; the save DC follows the SRD's scroll table.
const source = "SRD 5.1";
const scrollDc = (level: number): number => (level <= 2 ? 13 : level <= 4 ? 15 : level <= 6 ? 17 : level === 7 || level === 8 ? 18 : 19);
const rarityOf = (level: number): "common" | "uncommon" | "rare" | "very rare" | "legendary" =>
  level <= 1 ? "common" : level <= 3 ? "uncommon" : level <= 5 ? "rare" : level <= 8 ? "very rare" : "legendary";

const spells = [...srd51Cantrips, ...srd51Level1Spells, ...srd51UtilitySpells, ...srd51GeneratedSpells].filter(
  (definition: ContentDefinition): definition is SpellDefinition => definition.kind === "spell" && definition.castingTime !== "reaction" && definition.castingTime !== "long",
);

export const scrollIdOf = (spellId: string): ContentId<"item"> => `item:scroll-of-${spellId.slice("spell:".length)}` as ContentId<"item">;

export const spellScrolls: readonly ItemDefinition[] = spells.map((spell) =>
  defineMagicItem({
    id: scrollIdOf(spell.id),
    source,
    rarity: rarityOf(spell.level),
    attunement: false,
    category: "scroll",
    traits: [{ kind: "featureSpell", spell: spell.id, ability: "int", uses: 1, saveDc: scrollDc(spell.level), recharge: "never" }],
  }),
);

// For naming them: each scroll and the spell it holds.
export const spellScrollList: readonly { readonly id: ContentId<"item">; readonly spellId: string }[] = spells.map((spell) => ({ id: scrollIdOf(spell.id), spellId: spell.id }));
