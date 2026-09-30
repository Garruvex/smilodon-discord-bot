import { spellTargetProblem as magicTargetProblem } from "../magic/spell-rules.js";
import { conditionLookup, forbiddenAttackTargets, isFlying } from "../effects/effect-queries.js";
import type { SpellDefinition } from "../rules/content-definitions.js";
import type { SealedContent } from "../rules/content-registry.js";
import { areEngaged, isPresent, type AttackOption, type Combatant, type EncounterState } from "./combat-state.js";
import { distanceBetween } from "./positioning.js";

// Who a weapon or spell may be aimed at. One definition serves the engine (which
// refuses anything else) and the Discord menus (which list only these), so a
// menu never offers a target the engine would turn down.

export type TargetProblem = "invalidTarget" | "notEngaged" | "outOfRange";

// A foe on the battlefield; melee needs engagement, ranged needs the distance.
// Simplified: Charmed also blocks targeting the charmer with a beneficial
// spell in the SRD, which this treats the same as a harmful one — the engine
// has no notion of a spell's targeting being "harmful" to sort that out.
export function weaponTargetProblem(
  encounter: EncounterState,
  attacker: Combatant,
  target: Combatant | undefined,
  option: AttackOption,
  content: SealedContent,
): TargetProblem | null {
  if (target === undefined || target.side === attacker.side || !isPresent(target)) return "invalidTarget";
  if (forbiddenAttackTargets(attacker, conditionLookup(content)).includes(target.id)) return "invalidTarget";
  if (option.range.kind === "melee" && !areEngaged(encounter, attacker.id, target.id)) return "notEngaged";
  // Out of reach of anyone on the ground.
  if (option.range.kind === "melee" && isFlying(target, conditionLookup(content)) && !isFlying(attacker, conditionLookup(content))) return "invalidTarget";
  const distance = distanceBetween(encounter, attacker.id, target.id);
  if (option.range.kind === "ranged" && (distance === null || distance > option.range.long)) return "outOfRange";
  return null;
}

export function weaponTargets(encounter: EncounterState, attacker: Combatant, option: AttackOption, content: SealedContent): readonly Combatant[] {
  return Object.values(encounter.combatants).filter((target) => weaponTargetProblem(encounter, attacker, target, option, content) === null);
}

// The spell's relation (enemy, ally, self) and reach.
// The spell's own target rules live in Magic; this supplies the positions.
export function spellTargetProblem(
  encounter: EncounterState,
  caster: Combatant,
  spell: SpellDefinition,
  target: Combatant | undefined,
  content: SealedContent,
): TargetProblem | null {
  if (target !== undefined && forbiddenAttackTargets(caster, conditionLookup(content)).includes(target.id)) return "invalidTarget";
  const distance = target === undefined ? null : distanceBetween(encounter, caster.id, target.id);
  return magicTargetProblem(spell, caster, target, target !== undefined && isPresent(target), distance);
}

export function spellTargets(encounter: EncounterState, caster: Combatant, spell: SpellDefinition, content: SealedContent): readonly Combatant[] {
  if (spell.targeting.relation === "self") return [caster];
  return Object.values(encounter.combatants).filter((target) => spellTargetProblem(encounter, caster, spell, target, content) === null);
}
