import type { Combatant } from "../../../domain/campaign/combat/combat-state.js";
import type { MonsterDefinition } from "../../../domain/campaign/rules/content-definitions.js";
import type { SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import type { Trait } from "../../../domain/campaign/rules/traits.js";

// A short reference card for each kind of monster in the fight, built from the ruleset's own table by ID.
// The narrator reads it so it can describe what a creature can do without inventing powers; exact hit points
// stay hidden. Nothing here is copied from the SRD text: it is our own data put into words.
export function foeCards(foes: readonly Combatant[], content: SealedContent, names: Readonly<Record<string, string>>): string[] {
  const seen = new Set<string>();
  const cards: string[] = [];
  for (const foe of foes) {
    if (foe.source.kind !== "monster" || seen.has(foe.source.monsterId)) continue;
    seen.add(foe.source.monsterId);
    const monster = content.find(foe.source.monsterId);
    if (monster?.kind === "monster") cards.push(monsterCard(monster, content, names));
  }
  return cards;
}

function monsterCard(monster: MonsterDefinition, content: SealedContent, names: Readonly<Record<string, string>>): string {
  const name = (id: string): string => names[id] ?? id;
  const attacks = monster.attacks.map((attack) => name(attack.weapon));
  const traits = monster.traits.flatMap((trait) => describeTrait(trait, name));
  const spells = monster.spellcasting === undefined ? [] : [...monster.spellcasting.spells, ...monster.spellcasting.innate.map((entry) => entry.spell)].map(name);
  const parts = [
    attacks.length > 0 ? `attacks: ${attacks.join(", ")}` : null,
    traits.length > 0 ? traits.join("; ") : null,
    spells.length > 0 ? `casts: ${spells.join(", ")}` : null,
    monster.tactic === "skirmisher" ? "fights from range" : null,
  ].filter((part): part is string => part !== null);
  void content;
  return `- ${name(monster.id)}: ${parts.length === 0 ? "no special abilities" : parts.join("; ")}.`;
}

function describeTrait(trait: Trait, name: (id: string) => string): string[] {
  switch (trait.kind) {
    case "multiattack":
      return ["makes several attacks in one turn"];
    case "areaAttack":
      return [`has an area attack (${name(trait.weapon)}) it can only use now and then`];
    case "regeneration":
      return ["regenerates hit points each turn"];
    case "legendaryResistance":
      return ["can shrug off some failed saving throws"];
    case "legendaryActions":
      return ["acts between other creatures' turns"];
    case "packTactics":
      return ["fights better beside allies"];
    case "damageResistance":
      return [`resists ${trait.damageTypes.join(", ")} damage`];
    case "damageImmunity":
      return [`immune to ${trait.damageTypes.join(", ")} damage`];
    case "damageVulnerability":
      return [`takes extra ${trait.damageTypes.join(", ")} damage`];
    default:
      return [];
  }
}
