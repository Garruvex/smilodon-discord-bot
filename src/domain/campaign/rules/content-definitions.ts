import type { Capability } from "./capabilities.js";
import type { ContentId, ContentKind } from "./content-id.js";
import type { Effect, ResolutionPlan } from "./effects.js";

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

export type ContentDefinition = ConditionDefinition | SpellDefinition;

export type DefinitionOf<K extends ContentKind> = Extract<ContentDefinition, { kind: K }>;

export function defineCondition(definition: Omit<ConditionDefinition, "kind">): ConditionDefinition {
  return { ...definition, kind: "condition" };
}

export function defineSpell(definition: Omit<SpellDefinition, "kind">): SpellDefinition {
  return { ...definition, kind: "spell" };
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

function assertNever(value: never): never {
  throw new Error(`Unhandled content variant: ${JSON.stringify(value)}`);
}
