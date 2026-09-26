import { assertNever } from "../core/assert-never.js";
import type { Capability } from "./capabilities.js";
import type { ContentId, ContentKind } from "./content-id.js";
import type { DiceExpression } from "../dice/dice-expression.js";
import type { Ability, DamageType, Effect, ResolutionPlan } from "./effects.js";

interface DefinitionBase<K extends ContentKind> {
  readonly id: ContentId<K>;
  readonly kind: K;
  // Where the rules text comes from, e.g. "SRD 5.1". Required for attribution.
  readonly source: string;
  // Capabilities beyond those derived from the definition's shape.
  readonly extraRequires?: readonly Capability[];
}

export interface ConditionDefinition extends DefinitionBase<"condition"> {
  // Conditions this one always includes, e.g. Unconscious includes
  // Incapacitated and Prone.
  readonly includes: readonly ContentId<"condition">[];
}

export type CastingTime = "action" | "bonus-action" | "reaction";

export type SpellRange =
  | { readonly kind: "self" }
  | { readonly kind: "touch" }
  | { readonly kind: "feet"; readonly feet: number };

export interface SpellTargeting {
  readonly relation: "self" | "ally-or-self" | "creature" | "enemy";
  readonly count: number;
  // Extra targets per slot level above the spell's level (Bless: 1).
  readonly countPerHigherSlot?: number;
}

export interface SpellCastContext {
  // 0 for cantrips; otherwise the slot spent, >= the spell's level.
  readonly slotLevel: number;
  readonly casterLevel: number;
  readonly spellcastingModifier: number;
}

export interface SpellDefinition extends DefinitionBase<"spell"> {
  readonly level: number; // 0 = cantrip
  readonly castingTime: CastingTime;
  readonly range: SpellRange;
  readonly targeting: SpellTargeting;
  readonly concentration: boolean;
  plan(context: SpellCastContext): ResolutionPlan;
}

// Melee weapons reach 5 feet (no reach weapons in the milestone 0 catalog);
// ranged weapons have a normal and a long range in feet.
export type WeaponRange = { readonly kind: "melee" } | { readonly kind: "ranged"; readonly normal: number; readonly long: number };

export interface WeaponDefinition extends DefinitionBase<"item"> {
  readonly itemType: "weapon";
  readonly damage: DiceExpression;
  readonly damageType: DamageType;
  readonly range: WeaponRange;
  // Finesse: the wielder may use Dexterity instead of Strength.
  readonly finesse: boolean;
  // Natural weapons (bite, claws) belong to monsters and are never carried.
  readonly natural: boolean;
}

export type ItemDefinition = WeaponDefinition;

// How an ordinary monster fights without a model call (plan §6, NPCs and
// monsters in combat). brute: close in and hit the nearest hero.
// skirmisher: shoot from range when not engaged, otherwise fight in melee.
export type MonsterTactic = "brute" | "skirmisher";

// A stat-block attack: to-hit and damage are fixed by the stat block and
// already include the monster's modifiers.
export interface MonsterAttack {
  readonly weapon: ContentId<"item">;
  readonly toHit: number;
  readonly damage: DiceExpression;
}

// Rules a creature has, whatever it is. A closed union the combat engine
// applies with an exhaustive switch, so heroes, monsters, and NPCs share
// one implementation of each trait.
export type CreatureTrait =
  // Advantage on attacks while an ally is engaged with the target.
  { readonly kind: "packTactics" };

export interface MonsterDefinition extends DefinitionBase<"monster"> {
  readonly armorClass: number;
  // The stat block's average hit points.
  readonly maxHp: number;
  readonly speed: number;
  readonly abilityScores: Readonly<Record<Ability, number>>;
  readonly attacks: readonly MonsterAttack[];
  readonly tactic: MonsterTactic;
  readonly traits: readonly CreatureTrait[];
}

export type ContentDefinition = ConditionDefinition | SpellDefinition | ItemDefinition | MonsterDefinition;

export type DefinitionOf<K extends ContentKind> = Extract<ContentDefinition, { kind: K }>;

export function defineCondition(definition: Omit<ConditionDefinition, "kind">): ConditionDefinition {
  return { ...definition, kind: "condition" };
}

export function defineSpell(definition: Omit<SpellDefinition, "kind">): SpellDefinition {
  return { ...definition, kind: "spell" };
}

export function defineWeapon(definition: Omit<WeaponDefinition, "kind" | "itemType">): WeaponDefinition {
  return { ...definition, kind: "item", itemType: "weapon" };
}

export function defineMonster(definition: Omit<MonsterDefinition, "kind">): MonsterDefinition {
  return { ...definition, kind: "monster" };
}

export const maxSpellLevel = 9;

// Every slot level a spell can be cast at: [0] for cantrips, level..9 otherwise.
export function castableSlotLevels(spell: SpellDefinition): readonly number[] {
  if (spell.level === 0) return [0];
  return Array.from({ length: maxSpellLevel - spell.level + 1 }, (_, index) => spell.level + index);
}

// Plans evaluated for validation: every castable slot level, at a caster
// level that can cast it. Throws propagate to the registry as problems.
export function samplePlans(spell: SpellDefinition): readonly ResolutionPlan[] {
  return castableSlotLevels(spell).map((slotLevel) =>
    spell.plan({ slotLevel, casterLevel: Math.max(1, slotLevel * 2 - 1), spellcastingModifier: 3 }),
  );
}

export function requiredCapabilities(definition: ContentDefinition): ReadonlySet<Capability> {
  const required = new Set<Capability>(definition.extraRequires ?? []);
  switch (definition.kind) {
    case "condition":
      required.add("conditions");
      break;
    case "spell":
      if (definition.level > 0) required.add("spell-slots");
      if (definition.concentration) required.add("concentration");
      for (const plan of samplePlans(definition)) {
        if (plan.check?.kind === "spellAttack") required.add("attack-rolls");
        if (plan.check?.kind === "savingThrow") required.add("saving-throws");
        for (const effect of [...plan.onLand, ...plan.onAvoid]) required.add(capabilityFor(effect));
      }
      break;
    case "item":
    case "monster":
      required.add("attack-rolls");
      required.add("damage");
      break;
    default:
      assertNever(definition);
  }
  return required;
}

export function referencedContent(definition: ContentDefinition): readonly ContentId[] {
  switch (definition.kind) {
    case "condition":
      return definition.includes;
    case "spell":
      return samplePlans(definition).flatMap((plan) =>
        [...plan.onLand, ...plan.onAvoid].flatMap((effect) =>
          effect.kind === "applyCondition" ? [effect.condition] : [],
        ),
      );
    case "item":
      return [];
    case "monster":
      return definition.attacks.map((attack) => attack.weapon);
    default:
      return assertNever(definition);
  }
}

function capabilityFor(effect: Effect): Capability {
  switch (effect.kind) {
    case "damage":
      return "damage";
    case "heal":
      return "healing";
    case "applyCondition":
      return "conditions";
    case "bonusDie":
      return "bonus-dice";
    default:
      return assertNever(effect);
  }
}
