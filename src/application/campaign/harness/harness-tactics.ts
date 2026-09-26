import type { CombatCommand } from "../../../domain/campaign/commands/campaign-command.js";
import { engagedWith, isActive, type Combatant, type EncounterState } from "../../../domain/campaign/combat/combat-state.js";
import { distanceBetween, edgeBetween, engageCost } from "../../../domain/campaign/combat/positioning.js";
import { chooseMonsterPlan } from "../../../domain/campaign/combat/tactics.js";

// How a scripted player fights: a front-liner, a ranged skirmisher, or a
// healer who keeps allies standing.
export type HarnessCombatRole = "striker" | "skirmisher" | "healer";

const secondWind = "feature:second-wind";
const healingWord = "spell:healing-word";
const cureWounds = "spell:cure-wounds";
const sacredFlame = "spell:sacred-flame";

// The next command a scripted player sends on their turn, chosen fresh from
// the current state after every step. Movement and attacks reuse the monster
// tactics so heroes and foes follow the same positioning rules; the harness
// sends each step as a real player command, which the engine validates.
export function chooseHeroCommand(encounter: EncounterState, hero: Combatant, role: HarnessCombatRole): CombatCommand {
  const endTurn: CombatCommand = { kind: "endTurn", combatantId: hero.id };
  const foes = Object.values(encounter.combatants).filter((other) => other.side !== hero.side && isActive(other));
  if (foes.length === 0) return endTurn;
  const slots = hero.resources.spellSlots[1] ?? 0;
  const knows = (spellId: string): boolean => hero.spellcasting?.spells.includes(spellId as `spell:${string}`) === true;

  if (role === "healer" && slots > 0) {
    const downed = Object.values(encounter.combatants).find((ally) => ally.side === hero.side && ally.condition === "unconscious");
    if (downed !== undefined) {
      const distance = distanceBetween(encounter, hero.id, downed.id) ?? Infinity;
      if (hero.budget.bonusAction && knows(healingWord) && distance <= 60) {
        return { kind: "combatCast", combatantId: hero.id, spellId: healingWord, slotLevel: 1, targetIds: [downed.id] };
      }
      if (hero.budget.action && knows(cureWounds) && downed.zoneId === hero.zoneId) {
        return { kind: "combatCast", combatantId: hero.id, spellId: cureWounds, slotLevel: 1, targetIds: [downed.id] };
      }
    }
  }
  if (role === "striker" && hero.budget.bonusAction && hero.hp * 2 <= hero.maxHp && (hero.resources.featureUses[secondWind] ?? 0) > 0) {
    return { kind: "combatUseFeature", combatantId: hero.id, featureId: secondWind };
  }
  // A healer out of melee casts at range rather than walking in.
  if (role === "healer" && hero.budget.action && knows(sacredFlame) && engagedWith(encounter, hero.id).length === 0) {
    const target = foes.find((foe) => (distanceBetween(encounter, hero.id, foe.id) ?? Infinity) <= 60);
    if (target !== undefined) return { kind: "combatCast", combatantId: hero.id, spellId: sacredFlame, slotLevel: 0, targetIds: [target.id] };
  }

  const plan = chooseMonsterPlan(encounter, { ...hero, tactic: role === "skirmisher" ? "skirmisher" : "brute" });
  const [next] = plan.moves;
  if (next !== undefined) {
    const feet = edgeBetween(encounter.edges, hero.zoneId, next)?.feet ?? Infinity;
    if (feet <= hero.budget.movement) return { kind: "combatMove", combatantId: hero.id, zoneId: next };
    if (plan.dash && hero.budget.action) return { kind: "combatDash", combatantId: hero.id };
    return endTurn;
  }
  if (plan.engage !== null && hero.budget.movement >= engageCost && !engagedWith(encounter, hero.id).some((other) => other.id === plan.engage)) {
    return { kind: "combatEngage", combatantId: hero.id, targetId: plan.engage };
  }
  if (plan.attack !== null && hero.budget.action) return { kind: "combatAttack", combatantId: hero.id, targetId: plan.attack.targetId, weapon: plan.attack.option.weapon };
  if (plan.dodge && hero.budget.action) return { kind: "combatDodge", combatantId: hero.id };
  return endTurn;
}
