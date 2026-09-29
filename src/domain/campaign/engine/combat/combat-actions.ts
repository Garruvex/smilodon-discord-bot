// What a hero does with their action: a weapon attack, a spell, a feature. The rules for each are in combat/turn-rules.ts.
import type { ActionCost } from "../../combat/combat-events.js";
import { type AttackOption, type Combatant, type EncounterState } from "../../combat/combat-state.js";
import { attackProblem, featureProblem, smiteProblem, spellProblem } from "../../combat/turn-rules.js";
import type { ContentId } from "../../rules/content-id.js";
import type { AreaAttack } from "../../rules/traits.js";
import type { Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { declareResolution } from "./resolution.js";
import { activeEncounter } from "./combat-flow.js";

export const noCost: ActionCost = { action: false, bonusAction: false, reaction: false, spellSlot: null, featureUse: null };

export function declareWeaponAttack(
  decision: Decision,
  attacker: Combatant,
  targetId: string,
  option: AttackOption,
  purpose: "action" | "opportunity",
  smiteSlot?: number,
): Rejection | null {
  const encounter = activeEncounter(decision);
  if (encounter === null) return { code: "notInCombat" };
  const problem = attackProblem(encounter, attacker, option, targetId, purpose, decision.ctx.rules.content);
  if (problem !== null) return problem;
  if (smiteSlot !== undefined) {
    const smite = smiteProblem(attacker, option, smiteSlot);
    if (smite !== null) return smite;
  }
  // Extra Attack: the Attack action is spent the moment it is taken, on the
  // first of the attacks it grants, same as any other action — what makes
  // Extra Attack special is attacksLeft (evolve-combat.ts), a separate
  // counter that still permits further weapon attacks after the action
  // itself shows spent. Divine Smite's slot (see turn-rules.ts's
  // smiteProblem) is spent on declaring the attack, whether or not it goes
  // on to land.
  return declareResolution(decision, {
    actor: attacker,
    source: { kind: "weapon", option, ...(smiteSlot === undefined ? {} : { smiteSlot }) },
    targetIds: [targetId],
    purpose,
    cost: {
      ...noCost,
      action: purpose === "action",
      reaction: purpose === "opportunity",
      spellSlot: smiteSlot ?? null,
    },
  });
}

// A monster's breath weapon: the action, on every target caught.
export function declareAreaAttack(decision: Decision, attacker: Combatant, area: AreaAttack, targetIds: readonly string[]): Rejection | null {
  if (targetIds.length === 0 || !attacker.budget.action) return { code: "noActionLeft" };
  return declareResolution(decision, {
    actor: attacker,
    source: { kind: "area", area },
    targetIds,
    purpose: "action",
    cost: { ...noCost, action: true },
  });
}

export function castSpell(
  decision: Decision,
  encounter: EncounterState,
  caster: Combatant,
  spellId: ContentId<"spell">,
  slotLevel: number,
  targetIds: readonly string[],
): Rejection | null {
  const checked = spellProblem(encounter, decision.ctx.rules.content, caster, spellId, slotLevel, targetIds);
  if ("problem" in checked) return checked.problem;
  const { spell, bonus, targets } = checked.value;
  return declareResolution(decision, {
    actor: caster,
    source: { kind: "spell", spellId: spell.id, slotLevel },
    targetIds: targets,
    purpose: "action",
    cost: { ...noCost, action: !bonus, bonusAction: bonus, spellSlot: spell.level === 0 ? null : slotLevel },
  });
}

export function useFeature(decision: Decision, hero: Combatant, featureId: ContentId<"feature">): Rejection | null {
  const checked = featureProblem(hero, decision.ctx.rules.content, featureId);
  if ("problem" in checked) return checked.problem;
  const { feature, bonus } = checked.value;
  return declareResolution(decision, {
    actor: hero,
    source: { kind: "feature", featureId: feature.id },
    targetIds: [hero.id],
    purpose: "action",
    cost: { ...noCost, action: !bonus, bonusAction: bonus, featureUse: feature.id },
  });
}
