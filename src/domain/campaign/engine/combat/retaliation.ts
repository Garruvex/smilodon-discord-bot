// Retaliation: a hero who was damaged by a creature close by strikes back with their reaction.
import { isPresent, type ResolutionState } from "../../combat/combat-state.js";
import { canReact, conditionLookup, hasCondition } from "../../effects/effect-queries.js";
import type { Decision } from "../decision.js";
import { activeEncounter } from "./combat-flow.js";
import { declareWeaponAttack } from "./combat-actions.js";
import { landEffects } from "./resolution.js";

// Called as an action ends. Declares the first retaliation owed as a reaction that hands back to the action it followed;
// true when it did (the caller stops, and the reaction's own end hands on). Nobody retaliates against a reaction, so
// two retaliators cannot trade blows without end. Like the other reactions here it is not asked for: it happens unless
// the hero has chosen to hold their reactions.
export function offerRetaliation(decision: Decision, resolution: ResolutionState): boolean {
  const encounter = activeEncounter(decision);
  if (encounter === null || resolution.purpose === "reaction") return false;
  const attacker = encounter.combatants[resolution.actorId];
  if (attacker === undefined || !isPresent(attacker) || attacker.hp <= 0) return false;
  const lookup = conditionLookup(decision.ctx.rules.content);
  for (const targetId of resolution.targetIds) {
    const target = encounter.combatants[targetId];
    if (target === undefined || target.side === attacker.side || target.hp <= 0 || !canReact(target, lookup)) continue;
    if (!target.traits.some((trait) => trait.kind === "retaliation") || target.zoneId !== attacker.zoneId || hasCondition(target, "condition:holding-reactions", lookup)) continue;
    // Only damage counts: a spell or a blow that did nothing to the hero is no reason to strike back.
    const effects = resolution.outcomes[targetId]?.landed === true ? landEffects(resolution, encounter) : resolution.plan.onAvoid;
    if (!effects.some((effect) => effect.kind === "damage" && effect.target === "target")) continue;
    const option = target.attacks.find((attack) => attack.range.kind === "melee");
    if (option === undefined) continue;
    if (declareWeaponAttack(decision, target, attacker.id, option, "reaction", undefined, resolution.resumes ?? resolution) === null) return true;
  }
  return false;
}
