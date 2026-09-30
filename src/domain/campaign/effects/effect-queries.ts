import type { DiceExpression } from "../dice/dice-expression.js";
import type { ConditionDefinition } from "../rules/content-definitions.js";
import type { ContentId } from "../rules/content-id.js";
import type { SealedContent } from "../rules/content-registry.js";
import type { Ability } from "../rules/effects.js";
import type { MetamagicOption, Modifier, Reach, RollBias } from "../rules/modifiers.js";
import type { Trait } from "../rules/traits.js";
import type { EffectInstance, TriggerAction } from "./effect-instance.js";

// The rule queries: the one place that turns a creature's lasting effects into
// answers (may it act, how fast, with what bias on a roll). Callers ask these and
// never look for a condition by name. Values are computed from the current
// effects each time, never stored, so nothing goes stale when an effect ends.

// Any creature that carries effects. Combat's combatant satisfies it.
export interface EffectHolder {
  readonly effects: readonly EffectInstance[];
  // active can act; unconscious and stable are downed (they have condition:unconscious).
  readonly condition: "active" | "unconscious" | "stable" | "dead" | "fled";
  // Stances that last until the holder's next turn.
  readonly dodging: boolean;
  readonly disengaged: boolean;
  readonly speed: number;
  readonly budget: { readonly reaction: boolean };
  // 0-6, SRD 5.1 Exhaustion. Its per-level effects are synthesized into
  // modifiersOf/speedOf below rather than carried as a condition's own
  // modifiers, since (unlike every other condition) they change with level.
  readonly exhaustion: number;
}

export type ConditionLookup = (id: ContentId<"condition">) => ConditionDefinition | undefined;

const unconscious = "condition:unconscious" as ContentId<"condition">;

// Finds condition definitions in a ruleset's content.
export function conditionLookup(content: SealedContent): ConditionLookup {
  return (id) => {
    const definition = content.find(id);
    return definition?.kind === "condition" ? definition : undefined;
  };
}

export interface SourcedModifier {
  // Which condition, spell or stance the modifier comes from (for showing why).
  readonly source: string;
  readonly effectId: string | null;
  readonly modifier: Modifier;
}

// The conditions in force, with everything each one includes.
export function conditionsOf(holder: EffectHolder, lookup: ConditionLookup): readonly ContentId<"condition">[] {
  const found = new Set<ContentId<"condition">>();
  const add = (id: ContentId<"condition">): void => {
    if (found.has(id)) return;
    found.add(id);
    for (const included of lookup(id)?.includes ?? []) add(included);
  };
  for (const effect of holder.effects) effect.conditions.forEach(add);
  if (holder.condition === "unconscious" || holder.condition === "stable") add(unconscious);
  return [...found];
}

export function hasCondition(holder: EffectHolder, id: ContentId<"condition">, lookup: ConditionLookup): boolean {
  return conditionsOf(holder, lookup).includes(id);
}

// Every modifier in force, tagged with where it comes from.
export function modifiersOf(holder: EffectHolder, lookup: ConditionLookup): readonly SourcedModifier[] {
  const list: SourcedModifier[] = [];
  for (const effect of holder.effects) for (const modifier of effect.modifiers) list.push({ source: effect.definition, effectId: effect.id, modifier });
  for (const id of conditionsOf(holder, lookup)) for (const modifier of lookup(id)?.modifiers ?? []) list.push({ source: id, effectId: null, modifier });
  if (holder.dodging && holder.condition === "active") list.push({ source: "action:dodge", effectId: null, modifier: { kind: "attacksAgainst", mode: "disadvantage", reach: "any" } });
  if (holder.disengaged) list.push({ source: "action:disengage", effectId: null, modifier: { kind: "avoidsOpportunityAttacks" } });
  // Exhaustion 3+: disadvantage on attack rolls and saving throws. 5+: speed
  // 0 (speedOf below also halves it at 2+, which speedZero can't say).
  if (holder.exhaustion >= 3) {
    list.push({ source: "exhaustion", effectId: null, modifier: { kind: "ownAttacks", mode: "disadvantage" } });
    list.push({ source: "exhaustion", effectId: null, modifier: { kind: "saves", ability: "any", mode: "disadvantage" } });
  }
  if (holder.exhaustion >= 5) list.push({ source: "exhaustion", effectId: null, modifier: { kind: "speedZero" } });
  return list;
}

// ------------------------------------------------------------- Acting and moving

// The damage-resistance a creature has from lasting effects (Rage), in the Trait shape damageMultiplier reads.
export function effectResistances(holder: EffectHolder, lookup: ConditionLookup): readonly Trait[] {
  return modifiersOf(holder, lookup).flatMap(({ modifier }): Trait[] => (modifier.kind === "damageResistance" ? [{ kind: "damageResistance", damageTypes: modifier.damageTypes }] : []));
}

// Extra melee weapon damage from lasting effects (Rage).
export function attackBonusOf(holder: EffectHolder, lookup: ConditionLookup): number {
  return modifiersOf(holder, lookup).reduce((sum, { modifier }) => sum + (modifier.kind === "attackBonus" ? modifier.amount : 0), 0);
}

// The Metamagic readied for the next spell, and the effect to use up once it is cast.
export function armedMetamagic(holder: EffectHolder, lookup: ConditionLookup): { readonly option: MetamagicOption; readonly effectId: string } | null {
  for (const { modifier, effectId } of modifiersOf(holder, lookup)) if (modifier.kind === "metamagic" && effectId !== null) return { option: modifier.option, effectId };
  return null;
}

// The effects that hide this creature; making an attack or casting a spell gives it away.
export function hidingEffects(holder: EffectHolder): readonly string[] {
  return holder.effects.filter((effect) => effect.modifiers.some((modifier) => modifier.kind === "hidden")).map((effect) => effect.id);
}

// The readied Overchannel, if any, and the effect to use up once the spell is cast.
export function armedOverchannel(holder: EffectHolder, lookup: ConditionLookup): string | null {
  for (const { modifier, effectId } of modifiersOf(holder, lookup)) if (modifier.kind === "overchannel" && effectId !== null) return effectId;
  return null;
}

// The readied Stunning Strike, if any, and the effect to use up once the attack is made.
export function armedStunningStrike(holder: EffectHolder, lookup: ConditionLookup): string | null {
  for (const { modifier, effectId } of modifiersOf(holder, lookup)) if (modifier.kind === "stunningStrike" && effectId !== null) return effectId;
  return null;
}

export function meleeDamageBonusOf(holder: EffectHolder, lookup: ConditionLookup): number {
  return modifiersOf(holder, lookup).reduce((sum, { modifier }) => sum + (modifier.kind === "meleeDamageBonus" ? modifier.amount : 0), 0);
}

export function canAct(holder: EffectHolder, lookup: ConditionLookup): boolean {
  return holder.condition === "active" && !modifiersOf(holder, lookup).some(({ modifier }) => modifier.kind === "blocksActions");
}

export function canReact(holder: EffectHolder, lookup: ConditionLookup): boolean {
  return canAct(holder, lookup) && holder.budget.reaction;
}

// Speed after effects (grappled, restrained, and Exhaustion 5+ make it 0;
// Exhaustion 2-4 halves it, which speedZero has no way to say).
export function speedOf(holder: EffectHolder, lookup: ConditionLookup): number {
  if (modifiersOf(holder, lookup).some(({ modifier }) => modifier.kind === "speedZero")) return 0;
  return holder.exhaustion >= 2 ? Math.floor(holder.speed / 2) : holder.speed;
}

// Feet a creature's lasting effects add to its speed each turn.
export function speedBonusOf(holder: EffectHolder, lookup: ConditionLookup): number {
  return modifiersOf(holder, lookup).reduce((sum, { modifier }) => sum + (modifier.kind === "speedBonus" ? modifier.amount : 0), 0);
}

// Armor class after effects (Shield adds 5 until the caster's next turn).
export function armorClassOf(holder: EffectHolder & { readonly armorClass: number }, lookup: ConditionLookup): number {
  return holder.armorClass + modifiersOf(holder, lookup).reduce((sum, { modifier }) => sum + (modifier.kind === "acBonus" ? modifier.amount : 0), 0);
}

export function isFlying(holder: EffectHolder, lookup: ConditionLookup): boolean {
  return modifiersOf(holder, lookup).some(({ modifier }) => modifier.kind === "flying");
}

export function avoidsOpportunityAttacks(holder: EffectHolder, lookup: ConditionLookup): boolean {
  return modifiersOf(holder, lookup).some(({ modifier }) => modifier.kind === "avoidsOpportunityAttacks");
}

// Whoever the holder may not attack or target with a spell right now
// (Charmed). "cannotTargetSource" only means something read against the one
// effect that granted it, so — unlike every other modifier — this is read
// directly off holder.effects, not through modifiersOf()'s flattened list,
// which tags a condition-derived modifier with the condition's id, not the
// sourceId of the specific effect that applied it.
export function forbiddenAttackTargets(holder: EffectHolder, lookup: ConditionLookup): readonly string[] {
  const forbidden = new Set<string>();
  for (const effect of holder.effects) {
    for (const id of effect.conditions) if (lookup(id)?.modifiers.some((modifier) => modifier.kind === "cannotTargetSource") === true) forbidden.add(effect.sourceId);
  }
  return [...forbidden];
}

// ------------------------------------------------------------- Rolls

export interface BiasReason {
  readonly source: string;
  readonly mode: RollBias;
}

// How many sources push a roll toward advantage and toward disadvantage, and which.
export interface BiasTally {
  readonly advantage: number;
  readonly disadvantage: number;
  readonly reasons: readonly BiasReason[];
}

const reachApplies = (reach: Reach, within5: boolean): boolean => reach === "any" || (reach === "within5" ? within5 : !within5);

function tally(reasons: readonly BiasReason[]): BiasTally {
  return {
    advantage: reasons.filter((reason) => reason.mode === "advantage").length,
    disadvantage: reasons.filter((reason) => reason.mode === "disadvantage").length,
    reasons,
  };
}

// What effects add to an attack roll: the attacker's own, and those against the target.
// within5: the attacker is within 5 feet of the target.
export function attackBias(attacker: EffectHolder, target: EffectHolder, lookup: ConditionLookup, within5: boolean): BiasTally {
  const reasons: BiasReason[] = [];
  for (const { source, modifier } of modifiersOf(attacker, lookup)) {
    if (modifier.kind === "ownAttacks") reasons.push({ source, mode: modifier.mode });
    if (modifier.kind === "hidden") reasons.push({ source, mode: "advantage" });
  }
  for (const { source, modifier } of modifiersOf(target, lookup)) {
    if (modifier.kind === "attacksAgainst" && reachApplies(modifier.reach, within5)) reasons.push({ source, mode: modifier.mode });
    if (modifier.kind === "hidden") reasons.push({ source, mode: "disadvantage" });
  }
  return tally(reasons);
}

// The effect an attack against this creature uses up (the first one carrying usesUp).
export function effectsUsedUpByAttack(target: EffectHolder): readonly string[] {
  const used = target.effects.find((effect) => effect.modifiers.some((modifier) => modifier.kind === "attacksAgainst" && modifier.usesUp === true));
  return used === undefined ? [] : [used.id];
}

export function saveBias(holder: EffectHolder, ability: Ability, lookup: ConditionLookup): BiasTally {
  const reasons: BiasReason[] = [];
  for (const { source, modifier } of modifiersOf(holder, lookup)) {
    if (modifier.kind === "saves" && (modifier.ability === "any" || modifier.ability === ability)) reasons.push({ source, mode: modifier.mode });
  }
  return tally(reasons);
}

export function autoFailsSave(holder: EffectHolder, ability: Ability, lookup: ConditionLookup): boolean {
  return modifiersOf(holder, lookup).some(({ modifier }) => modifier.kind === "autoFailSaves" && modifier.abilities.includes(ability));
}

// A hit against this creature from this reach is a critical hit (an unconscious creature, close by).
export function hitsAreCritical(target: EffectHolder, lookup: ConditionLookup, within5: boolean): boolean {
  return modifiersOf(target, lookup).some(({ modifier }) => modifier.kind === "critsAgainst" && reachApplies(modifier.reach, within5));
}

// Dice added to this creature's rolls of one kind (Bless).
export function bonusDiceFor(holder: Pick<EffectHolder, "effects">, kind: "attack" | "save"): readonly { readonly source: string; readonly die: DiceExpression }[] {
  return holder.effects.flatMap((effect) =>
    effect.modifiers.flatMap((modifier) => (modifier.kind === "bonusDie" && modifier.appliesTo.includes(kind) ? [{ source: modifier.source, die: modifier.die }] : [])),
  );
}

// ------------------------------------------------------------- Lifetimes

// One trigger of one effect, named by where it is.
export interface TriggerRef {
  readonly holderId: string;
  readonly effectId: string;
  readonly index: number;
}

export const triggerKey = (ref: TriggerRef): string => `${ref.effectId}#${ref.index}`;

// The triggers that run at this creature's turn boundary, in the order the effects
// were applied, leaving out those already run this boundary (`done`).
export function triggersDueAt(
  creatures: readonly { readonly id: string; readonly effects: readonly EffectInstance[] }[],
  creatureId: string,
  boundary: "start" | "end",
  done: readonly string[],
): readonly (TriggerRef & { readonly does: TriggerAction })[] {
  return creatures.flatMap((holder) =>
    holder.effects.flatMap((effect) =>
      effect.triggers.flatMap((trigger, index) => {
        const ref = { holderId: holder.id, effectId: effect.id, index };
        const owner = trigger.follows === "source" ? effect.sourceId : holder.id;
        return trigger.boundary === boundary && owner === creatureId && !done.includes(triggerKey(ref)) ? [{ ...ref, does: trigger.does }] : [];
      }),
    ),
  );
}

// Which effects on these creatures end at this creature's turn boundary: the ones
// whose clock follows it (as source or as holder) and has run out. Grouped by holder.
export function effectsDueAt(
  creatures: readonly { readonly id: string; readonly effects: readonly EffectInstance[] }[],
  creatureId: string,
  boundary: "start" | "end",
  round: number,
): readonly { readonly holderId: string; readonly effects: readonly EffectInstance[] }[] {
  return creatures.flatMap((holder) => {
    const due = holder.effects.filter((effect) => {
      const clock = effect.clock;
      if (clock === null || clock.boundary !== boundary || round < clock.untilRound) return false;
      return (clock.follows === "source" ? effect.sourceId : holder.id) === creatureId;
    });
    return due.length === 0 ? [] : [{ holderId: holder.id, effects: due }];
  });
}
