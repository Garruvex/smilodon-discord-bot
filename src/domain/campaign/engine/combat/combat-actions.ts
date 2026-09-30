// What a hero does with their action: a weapon attack, a spell, a feature. The rules for each are in combat/turn-rules.ts.
import { useKeyOf } from "../../rules/content-definitions.js";
import { proficiencyBonusForLevel } from "../../character/leveling.js";
import { armedMetamagic, armedOverchannel, armedQuiveringPalm, armedStunningStrike, conditionLookup, hidingEffects } from "../../effects/effect-queries.js";
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
  purpose: "action" | "opportunity" | "legendary",
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
  // Stunning Strike (Monk 5): a readied one rides on this melee attack and is used up by it.
  const stunning = option.range.kind === "melee" ? armedStunningStrike(attacker, conditionLookup(decision.ctx.rules.content)) : null;
  const stunDc = stunning === null ? undefined : 8 + proficiencyBonusForLevel(attacker.level) + (attacker.saves.wis ?? 0);
  // Quivering Palm (Monk 17): the same for the palm, against the same save.
  const palm = option.range.kind === "melee" ? armedQuiveringPalm(attacker, conditionLookup(decision.ctx.rules.content)) : null;
  const palmDc = palm === null ? undefined : 8 + proficiencyBonusForLevel(attacker.level) + (attacker.saves.wis ?? 0);
  const declared = declareResolution(decision, {
    actor: attacker,
    source: { kind: "weapon", option, ...(smiteSlot === undefined ? {} : { smiteSlot }), ...(stunDc === undefined ? {} : { stunDc }), ...(palmDc === undefined ? {} : { palmDc }) },
    targetIds: [targetId],
    purpose,
    cost: {
      ...noCost,
      action: purpose === "action",
      reaction: purpose === "opportunity",
      spellSlot: smiteSlot ?? null,
    },
  });
  if (declared === null && stunning !== null) decision.emit({ kind: "effectsRemoved", combatantId: attacker.id, effectIds: [stunning], reason: "usedUp" });
  if (declared === null && palm !== null) decision.emit({ kind: "effectsRemoved", combatantId: attacker.id, effectIds: [palm], reason: "usedUp" });
  if (declared === null) revealed(decision, attacker);
  return declared;
}

// A monster's breath weapon: the action, on every target caught.
export function declareAreaAttack(decision: Decision, attacker: Combatant, area: AreaAttack, targetIds: readonly string[], purpose: "action" | "legendary" = "action"): Rejection | null {
  if (targetIds.length === 0 || (purpose === "action" && !attacker.budget.action)) return { code: "noActionLeft" };
  return declareResolution(decision, {
    actor: attacker,
    source: { kind: "area", area },
    targetIds,
    purpose,
    // An aura costs nothing of the action itself, and neither does a legendary action.
    cost: { ...noCost, action: area.free !== true && purpose === "action" },
  });
}

export function castSpell(
  decision: Decision,
  encounter: EncounterState,
  caster: Combatant,
  spellId: ContentId<"spell">,
  slotLevel: number,
  targetIds: readonly string[],
  zoneId?: string,
): Rejection | null {
  const armed = armedMetamagic(caster, conditionLookup(decision.ctx.rules.content));
  const checked = spellProblem(encounter, decision.ctx.rules.content, caster, spellId, slotLevel, targetIds, armed?.option ?? null, zoneId);
  if ("problem" in checked) return checked.problem;
  const { spell, bonus, targets } = checked.value;
  const overchannel = spell.level >= 1 && spell.level <= 5 ? armedOverchannel(caster, conditionLookup(decision.ctx.rules.content)) : null;
  const declared = declareResolution(decision, {
    actor: caster,
    source: {
      kind: "spell",
      spellId: spell.id,
      slotLevel,
      ...(overchannel === null ? {} : { maximized: true as const }),
      ...(spell.targeting.destination === true && zoneId !== undefined ? { destination: zoneId } : {}),
      ...(armed === null || armed.option === "quickened" || armed.option === "twinned" ? {} : { metamagic: armed.option }),
    },
    targetIds: targets,
    purpose: "action",
    cost: { ...noCost, action: !bonus, bonusAction: bonus, spellSlot: spell.level === 0 || caster.spellcasting?.innate?.[spell.id] !== undefined ? null : slotLevel },
  });
  // The readied Metamagic is used up by the casting.
  if (declared === null && armed !== null) decision.emit({ kind: "effectsRemoved", combatantId: caster.id, effectIds: [armed.effectId], reason: "usedUp" });
  if (declared === null) revealed(decision, caster);
  if (declared === null && overchannel !== null) decision.emit({ kind: "effectsRemoved", combatantId: caster.id, effectIds: [overchannel], reason: "usedUp" });
  return declared;
}

// Attacking or casting gives away a hiding creature.
function revealed(decision: Decision, creature: Combatant): void {
  const hiding = hidingEffects(activeEncounter(decision)?.combatants[creature.id] ?? creature);
  if (hiding.length > 0) decision.emit({ kind: "effectsRemoved", combatantId: creature.id, effectIds: hiding, reason: "usedUp" });
}

export function useFeature(decision: Decision, hero: Combatant, featureId: ContentId<"feature">): Rejection | null {
  const checked = featureProblem(hero, decision.ctx.rules.content, featureId, activeEncounter(decision));
  if ("problem" in checked) return checked.problem;
  const { feature, bonus, free } = checked.value;
  return declareResolution(decision, {
    actor: hero,
    source: { kind: "feature", featureId: feature.id },
    targetIds: [hero.id],
    purpose: "action",
    cost: { ...noCost, action: !bonus && !free, bonusAction: bonus, featureUse: useKeyOf(feature), ...(feature.action?.spend === undefined ? {} : { featureUseAmount: feature.action.spend }) },
  });
}
