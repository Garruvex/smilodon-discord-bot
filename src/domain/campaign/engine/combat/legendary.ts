// Legendary actions: after another creature's turn ends, a monster that has them spends some on an attack.
import { currentCombatant, isActive } from "../../combat/combat-state.js";
import { weaponTargets } from "../../combat/legal-targets.js";
import { canAct, conditionLookup } from "../../effects/effect-queries.js";
import { legendaryActionsKey } from "../../rules/traits.js";
import type { Decision } from "../decision.js";
import { distanceBetween } from "../../combat/positioning.js";
import { declareAreaAttack, declareWeaponAttack } from "./combat-actions.js";
import { activeEncounter } from "./combat-flow.js";

// Declares one legendary attack if any monster can make one now; true when it did (the turn
// then waits for the attack to finish, and asks again). Each monster acts once per turn's end,
// and never at the end of its own turn.
export function takeLegendaryAction(decision: Decision): boolean {
  const encounter = activeEncounter(decision);
  if (encounter === null || encounter.status !== "active") return false;
  const ended = currentCombatant(encounter);
  const content = decision.ctx.rules.content;
  const lookup = conditionLookup(content);
  for (const monster of Object.values(encounter.combatants)) {
    const trait = monster.traits.find((entry) => entry.kind === "legendaryActions");
    if (trait === undefined || monster.side !== "foes" || monster.id === ended?.id || !isActive(monster) || !canAct(monster, lookup)) continue;
    if (monster.legendaryTurn === encounter.turnNumber) continue;
    const left = monster.resources.featureUses[legendaryActionsKey] ?? 0;
    // The dearest attack it can pay for and has someone to hit.
    for (const choice of [...trait.options].sort((a, b) => b.cost - a.cost)) {
      if (choice.cost > left) continue;
      // A dragon's Wing Attack and its kin: an area every foe close by is caught in.
      const area = monster.traits.find((entry) => entry.kind === "areaAttack" && entry.weapon === choice.weapon);
      if (area?.kind === "areaAttack") {
        const caught = Object.values(encounter.combatants).filter((foe) => foe.side !== monster.side && isActive(foe) && (distanceBetween(encounter, monster.id, foe.id) ?? Infinity) <= area.range);
        if (caught.length === 0) continue;
        decision.emit({ kind: "monsterStateChanged", combatantId: monster.id, legendarySpent: choice.cost, legendaryTurn: encounter.turnNumber });
        const fresh = activeEncounter(decision)?.combatants[monster.id] ?? monster;
        if (declareAreaAttack(decision, fresh, area, caught.map((foe) => foe.id), "legendary") === null) return true;
        continue;
      }
      const option = monster.attacks.find((attack) => attack.weapon === choice.weapon);
      if (option === undefined) continue;
      const [target] = [...weaponTargets(encounter, monster, option, content)].sort((a, b) => (a.hp !== b.hp ? a.hp - b.hp : a.id.localeCompare(b.id)));
      if (target === undefined) continue;
      decision.emit({ kind: "monsterStateChanged", combatantId: monster.id, legendarySpent: choice.cost, legendaryTurn: encounter.turnNumber });
      const fresh = activeEncounter(decision)?.combatants[monster.id] ?? monster;
      if (declareWeaponAttack(decision, fresh, target.id, option, "legendary") === null) return true;
    }
  }
  return false;
}
