// Death Burst: a monster that has just died goes off, and everyone left in its zone makes the saving throw.
import { isPresent, type ResolutionState } from "../../combat/combat-state.js";
import { deathBurstKey, type AreaAttack } from "../../rules/traits.js";
import type { Decision } from "../decision.js";
import { activeEncounter } from "./combat-flow.js";
import { declareResolution } from "./resolution.js";

// Called as an action ends. Declares the burst of the first monster that has died with one still to go off, as a
// reaction that hands back to the action it followed; true when it did (the caller stops, and the burst's own end
// asks again for any other). A monster whose zone holds no one else spends its burst on nothing.
export function offerDeathBurst(decision: Decision, resolution: ResolutionState): boolean {
  const encounter = activeEncounter(decision);
  if (encounter === null) return false;
  for (const dead of Object.values(encounter.combatants)) {
    const trait = dead.condition === "dead" && (dead.resources.featureUses[deathBurstKey] ?? 0) > 0 ? dead.traits.find((entry) => entry.kind === "deathBurst") : undefined;
    if (trait === undefined) continue;
    decision.emit({ kind: "monsterStateChanged", combatantId: dead.id, burstSpent: true });
    const caught = Object.values(encounter.combatants).filter((other) => other.id !== dead.id && isPresent(other) && other.zoneId === dead.zoneId);
    if (caught.length === 0) continue;
    const area: AreaAttack = {
      kind: "areaAttack",
      weapon: trait.weapon,
      ability: trait.ability,
      dc: trait.dc,
      halfOnSave: trait.halfOnSave,
      range: 5,
      cooldown: 0,
      ...(trait.damage === undefined || trait.damageType === undefined ? {} : { damage: trait.damage, damageType: trait.damageType }),
      ...(trait.condition === undefined ? {} : { condition: trait.condition }),
    };
    const declared = declareResolution(decision, {
      actor: dead,
      source: { kind: "area", area },
      targetIds: caught.map((other) => other.id),
      purpose: "reaction",
      resumes: resolution.resumes ?? resolution,
      cost: { action: false, bonusAction: false, reaction: false, spellSlot: null, featureUse: null },
    });
    if (declared === null) return true;
  }
  return false;
}
