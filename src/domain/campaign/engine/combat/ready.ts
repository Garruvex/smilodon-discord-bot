// Ready: a hero who readied an attack makes it, as a reaction, against the first foe that attacks before their next turn.
import { isPresent, type ResolutionState } from "../../combat/combat-state.js";
import { weaponTargetProblem } from "../../combat/legal-targets.js";
import { conditionLookup, hasCondition } from "../../effects/effect-queries.js";
import type { Decision } from "../decision.js";
import { activeEncounter } from "./combat-flow.js";
import { declareWeaponAttack } from "./combat-actions.js";

const readied = "condition:readied";

// Called as an action ends (after the reactions that answer damage). Declares the first readied attack that can reach the attacker as a
// reaction that hands back to the action it followed; true when it did. The readiness is spent whether or not the blow lands.
export function offerReady(decision: Decision, resolution: ResolutionState): boolean {
  const encounter = activeEncounter(decision);
  if (encounter === null || resolution.purpose === "reaction") return false;
  const attacker = encounter.combatants[resolution.actorId];
  if (attacker === undefined || !isPresent(attacker) || attacker.hp <= 0) return false;
  const isAttack = resolution.plan.check?.kind === "weaponAttack" || resolution.plan.check?.kind === "spellAttack" || resolution.plan.onLand.some((effect) => effect.kind === "damage");
  if (!isAttack) return false;
  const content = decision.ctx.rules.content;
  const lookup = conditionLookup(content);
  for (const hero of Object.values(encounter.combatants)) {
    if (hero.side === attacker.side || hero.condition !== "active" || hero.hp <= 0 || !hero.budget.reaction || !hasCondition(hero, readied, lookup) || hasCondition(hero, "condition:holding-reactions", lookup)) continue;
    const option = hero.attacks.find((attack) => weaponTargetProblem(encounter, hero, attacker, attack, content) === null);
    if (option === undefined) continue;
    const effectIds = hero.effects.filter((effect) => effect.definition === readied).map((effect) => effect.id);
    decision.emit({ kind: "effectsRemoved", combatantId: hero.id, effectIds, reason: "expired" });
    if (declareWeaponAttack(decision, hero, attacker.id, option, "reaction", undefined, resolution.resumes ?? resolution) === null) return true;
  }
  return false;
}
