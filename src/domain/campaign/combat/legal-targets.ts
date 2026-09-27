import { spellTargetProblem as magicTargetProblem } from "../magic/spell-rules.js";
import type { SpellDefinition } from "../rules/content-definitions.js";
import { areEngaged, isPresent, type AttackOption, type Combatant, type EncounterState } from "./combat-state.js";
import { distanceBetween } from "./positioning.js";

// Who a weapon or spell may be aimed at. One definition serves the engine (which
// refuses anything else) and the Discord menus (which list only these), so a
// menu never offers a target the engine would turn down.

export type TargetProblem = "invalidTarget" | "notEngaged" | "outOfRange";

// A foe on the battlefield; melee needs engagement, ranged needs the distance.
export function weaponTargetProblem(
  encounter: EncounterState,
  attacker: Combatant,
  target: Combatant | undefined,
  option: AttackOption,
): TargetProblem | null {
  if (target === undefined || target.side === attacker.side || !isPresent(target)) return "invalidTarget";
  if (option.range.kind === "melee" && !areEngaged(encounter, attacker.id, target.id)) return "notEngaged";
  const distance = distanceBetween(encounter, attacker.id, target.id);
  if (option.range.kind === "ranged" && (distance === null || distance > option.range.long)) return "outOfRange";
  return null;
}

export function weaponTargets(encounter: EncounterState, attacker: Combatant, option: AttackOption): readonly Combatant[] {
  return Object.values(encounter.combatants).filter((target) => weaponTargetProblem(encounter, attacker, target, option) === null);
}

// The spell's relation (enemy, ally, self) and reach.
// The spell's own target rules live in Magic; this supplies the positions.
export function spellTargetProblem(
  encounter: EncounterState,
  caster: Combatant,
  spell: SpellDefinition,
  target: Combatant | undefined,
): TargetProblem | null {
  const distance = target === undefined ? null : distanceBetween(encounter, caster.id, target.id);
  return magicTargetProblem(spell, caster, target, target !== undefined && isPresent(target), distance);
}

export function spellTargets(encounter: EncounterState, caster: Combatant, spell: SpellDefinition): readonly Combatant[] {
  if (spell.targeting.relation === "self") return [caster];
  return Object.values(encounter.combatants).filter((target) => spellTargetProblem(encounter, caster, spell, target) === null);
}
