// What a hero does with their action: a weapon attack, a spell, a feature. The rules for each are in combat/turn-rules.ts.
import type { ActionCost } from "../../combat/combat-events.js";
import { type AttackOption, type Combatant, type EncounterState } from "../../combat/combat-state.js";
import { attackProblem, featureProblem, spellProblem } from "../../combat/turn-rules.js";
import type { ContentId } from "../../rules/content-id.js";
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
): Rejection | null {
  const encounter = activeEncounter(decision);
  if (encounter === null) return { code: "notInCombat" };
  const problem = attackProblem(encounter, attacker, option, targetId, purpose, decision.ctx.rules.content);
  if (problem !== null) return problem;
  return declareResolution(decision, {
    actor: attacker,
    source: { kind: "weapon", option },
    targetIds: [targetId],
    purpose,
    cost: { ...noCost, action: purpose === "action", reaction: purpose === "opportunity" },
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
