import { formatDiceExpression } from "../../../domain/campaign/dice/dice-expression.js";
import type { SealedContent, Glossary } from "../../../domain/campaign/rules/content-registry.js";
import type { SpellDefinition } from "../../../domain/campaign/rules/content-definitions.js";
import type { Effect } from "../../../domain/campaign/rules/effects.js";

// What the rules book says about a spell, read from the spell's own definition so the book can never disagree with the engine.
// Plain data: the page puts it into words in the player's language.
export type SpellEffectFact =
  | { readonly kind: "damage"; readonly dice: string; readonly damageType: string; readonly half: boolean }
  | { readonly kind: "heal" | "tempHp"; readonly dice: string }
  | { readonly kind: "condition"; readonly name: string }
  | { readonly kind: "summon"; readonly name: string; readonly count: number }
  // Anything else the engine does (push, teleport, revive...): named by its effect kind, which the page knows how to word.
  | { readonly kind: "other"; readonly what: string };

export interface SpellFacts {
  readonly name: string;
  readonly level: number;
  readonly school: string | null;
  readonly castingTime: string;
  readonly range: { readonly kind: "self" | "touch" | "feet"; readonly feet?: number };
  readonly concentration: boolean;
  readonly ritual: boolean;
  readonly relation: string;
  readonly targets: number;
  readonly area: boolean;
  readonly destination: boolean;
  // How it is decided: a spell attack, a saving throw of this ability, or nothing (it just works).
  readonly check: "attack" | "none" | string;
  readonly effects: readonly SpellEffectFact[];
  // Hits harder (or reaches further) cast with a higher slot, or as the caster grows.
  readonly scales: boolean;
  // The damage or healing adds the caster's spellcasting modifier.
  readonly addsModifier: boolean;
}

const otherKinds = new Set<Effect["kind"]>(["push", "teleport", "revive", "stabilize", "dispel", "makeDifficult", "setLighting", "polymorph", "removeCondition", "grantMovement", "nextAttackAdvantage", "destroy", "bonusDie", "applyModifiers", "exhaustion"]);

function effectFacts(effects: readonly Effect[], glossary: Glossary, modifier: number): readonly SpellEffectFact[] {
  const facts: SpellEffectFact[] = [];
  for (const effect of effects) {
    switch (effect.kind) {
      case "damage": facts.push({ kind: "damage", dice: formatDiceExpression(effect.amount), damageType: effect.damageType, half: false }); break;
      case "heal": facts.push({ kind: "heal", dice: formatDiceExpression(effect.amount) }); break;
      case "tempHp": facts.push({ kind: "tempHp", dice: formatDiceExpression(effect.amount) }); break;
      case "applyCondition":
      case "conditionUnlessSave": facts.push({ kind: "condition", name: glossary.names[effect.condition] ?? effect.condition.replace(/^[a-z]+:/, "") }); break;
      case "summon": facts.push({ kind: "summon", name: glossary.names[effect.monsterId] ?? effect.monsterId.replace(/^[a-z]+:/, ""), count: effect.count }); break;
      default: if (otherKinds.has(effect.kind)) facts.push({ kind: "other", what: effect.kind });
    }
  }
  void modifier;
  return facts;
}

const sameFacts = (left: readonly SpellEffectFact[], right: readonly SpellEffectFact[]): boolean => JSON.stringify(left) === JSON.stringify(right);

export function buildSpellFacts(spell: SpellDefinition, glossary: Glossary): SpellFacts {
  const name = glossary.names[spell.id] ?? spell.id.replace(/^[a-z]+:/, "").replaceAll("-", " ");
  const planAt = (slotLevel: number, casterLevel: number, spellcastingModifier: number) => {
    try { return spell.plan({ slotLevel, casterLevel, spellcastingModifier }); } catch { return null; }
  };
  const base = planAt(spell.level, 1, 0);
  const landing = base === null ? [] : effectFacts(base.onLand, glossary, 0);
  const avoided = base?.onAvoid ?? [];
  const halved = avoided.some((effect) => effect.kind === "damage" && effect.halfOfLand === true);
  const effects = landing.map((fact) => fact.kind === "damage" ? { ...fact, half: halved } : fact);
  // Does it grow? Compare a higher slot (a cantrip: a higher character level) against the base casting.
  const higher = spell.level === 0 ? planAt(0, 17, 0) : planAt(Math.min(9, spell.level + 1), 20, 0);
  const scales = higher !== null && !sameFacts(effects, effectFacts(higher.onLand, glossary, 0).map((fact) => fact.kind === "damage" ? { ...fact, half: halved } : fact));
  // Does the spellcasting modifier change the numbers?
  const modified = planAt(spell.level, 1, 3);
  const addsModifier = modified !== null && !sameFacts(landing, effectFacts(modified.onLand, glossary, 3));
  const check = base?.check == null ? "none" : base.check.kind === "savingThrow" ? base.check.ability : "attack";
  return {
    name,
    level: spell.level,
    school: spell.school ?? null,
    castingTime: spell.castingTime,
    range: spell.range.kind === "feet" ? { kind: "feet", feet: spell.range.feet } : { kind: spell.range.kind },
    concentration: spell.concentration,
    ritual: spell.ritual === true,
    relation: spell.targeting.relation,
    targets: spell.targeting.count,
    area: spell.targeting.area === true,
    destination: spell.targeting.destination === true,
    check,
    effects,
    scales,
    addsModifier,
  };
}

// The facts for every spell a hero can see, by the name the page shows.
export function spellFactsByName(ids: Iterable<string>, content: SealedContent, glossary: Glossary): Readonly<Record<string, SpellFacts>> {
  const facts: Record<string, SpellFacts> = {};
  for (const id of new Set(ids)) {
    const definition = content.find(id);
    if (definition?.kind !== "spell") continue;
    const entry = buildSpellFacts(definition as SpellDefinition, glossary);
    facts[entry.name] = entry;
  }
  return facts;
}
