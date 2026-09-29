import type { ContentDefinition, ReactionRule } from "../../rules/content-definitions.js";
import { ContentRegistryBuilder, type ContentBuildOptions, type SealedContent } from "../../rules/content-registry.js";
import { srd51Classes } from "./classes.js";
import { srd51Conditions } from "./conditions.js";
import { srd51Level1Features } from "./features/level-1-features.js";
import { srd51ClassActions } from "./features/class-actions.js";
import { srd51HigherLevelFeatures } from "./features/higher-level-features.js";
import { srd51Armor } from "./items/armor.js";
import { srd51Potions } from "./items/potions.js";
import { srd51Weapons } from "./items/weapons.js";
import { srd51EnchantedGear } from "./items/magic-gear.js";
import { srd51MagicItems } from "./items/srd-magic-items.generated.js";
import { spellScrolls } from "./items/spell-scrolls.js";
import { srd51GeneratedItems } from "./items/srd-equipment.generated.js";
import { srd51CreatureTypes, srd51Darkvision } from "./monsters/creature-types.generated.js";
import { srd51MoreMonsters } from "./monsters/more-monsters.js";
import { srd51GeneratedMonsters } from "./monsters/srd-monsters.generated.js";
import { srd51StarterMonsters } from "./monsters/starter-monsters.js";
import { srd51DragonAncestries, srd51Races, srd51Subraces } from "./races.js";
import { srd51ClassAbilitySpells } from "./spells/class-ability-spells.js";
import { srd51Cantrips } from "./spells/cantrips.js";
import { srd51Level1Spells } from "./spells/level-1.js";
import { srd51GeneratedSpells } from "./spells/srd-spells.generated.js";
import { srd51UtilitySpells } from "./spells/utility.js";

export const srd51RulesetId = "srd-5.1";
// Bump when any shipped definition changes behavior; campaigns pin a version.
export const srd51Version = "2026.1";

// A monster carries its creature type as a trait, so the rules that name undead, fiends and the like can read it.
// The same wrapper gives a monster its darkvision (or blindsight and the like), which the dark-zone rules read.
const withCreatureType = (definition: ContentDefinition): ContentDefinition => {
  if (definition.kind !== "monster") return definition;
  const type = srd51CreatureTypes[definition.id];
  const feet = srd51Darkvision[definition.id];
  const traits = [...definition.traits, ...(type === undefined ? [] : [{ kind: "creatureType" as const, type }]), ...(feet === undefined ? [] : [{ kind: "darkvision" as const, feet }])];
  return traits.length === definition.traits.length ? definition : { ...definition, traits };
};

// Spells cast as a reaction: what sets each one off (engine/combat/reactions.ts).
const reactionRules: Readonly<Record<string, ReactionRule>> = { "spell:counterspell": { kind: "counterspell" }, "spell:hellish-rebuke": { kind: "retort" } };
const withReaction = (definition: ContentDefinition): ContentDefinition => {
  const reaction = definition.kind === "spell" ? reactionRules[definition.id] : undefined;
  return reaction === undefined || definition.kind !== "spell" ? definition : { ...definition, reaction };
};

const srd51Definitions: readonly ContentDefinition[] = [
  ...srd51Conditions,
  ...srd51Cantrips,
  ...srd51Level1Spells,
  ...srd51UtilitySpells,
  ...srd51GeneratedSpells,
  ...srd51ClassAbilitySpells,
  ...srd51Weapons,
  ...srd51Armor,
  ...srd51Potions,
  ...srd51Level1Features,
  ...srd51HigherLevelFeatures,
  ...srd51ClassActions,
  ...srd51StarterMonsters,
  ...srd51MoreMonsters,
  ...srd51GeneratedMonsters,
  ...srd51GeneratedItems,
  ...srd51MagicItems,
  ...srd51EnchantedGear,
  ...spellScrolls,
  ...srd51Classes,
  ...srd51Races,
  ...srd51Subraces,
  ...srd51DragonAncestries,
];

export const srd51Content: readonly ContentDefinition[] = srd51Definitions.map(withCreatureType).map(withReaction);

export function buildSrd51(options: ContentBuildOptions): SealedContent {
  return new ContentRegistryBuilder(srd51RulesetId, srd51Version).add(srd51Content).build(options);
}
