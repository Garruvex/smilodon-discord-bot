// Wild Shape (Druid, level 2): borrows a beast's stat block for combat
// purposes as a bonus action, and reverts to the hero's own the same way, or
// when the beast form drops to 0 HP (damage.ts), which carries the excess
// damage over to the hero. Two uses between short rests; the beasts on offer
// depend on the druid's level (rules/wild-shape-rules.ts).
//
// Simplified: a hero's class features besides spellcasting (Sneak Attack, Extra
// Attack, and so on) are left untouched rather than checked against the new
// form, since the roster has nothing that would conflict.
import { monsterAttackOptions } from "../../combat/combatant-profile.js";
import type { Combatant } from "../../combat/combat-state.js";
import { costProblem, shapeSource, wildShapeProblem } from "../../combat/turn-rules.js";
import type { ContentId } from "../../rules/content-id.js";
import { wildShapeFeature } from "../../rules/wild-shape-rules.js";
import type { Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";

export function wildShape(decision: Decision, hero: Combatant, monsterId: ContentId<"monster"> | undefined): Rejection | null {
  const content = decision.ctx.rules.content;
  const problem = wildShapeProblem(hero, content, monsterId);
  if (problem !== null) return problem;
  const cost = costProblem(hero, "bonusAction", content);
  if (cost !== null) return cost;

  if (monsterId === undefined) {
    revertWildShape(decision, hero);
    return null;
  }

  const beast = content.get(monsterId);
  decision.emit({
    kind: "wildShapeChanged",
    combatantId: hero.id,
    attacks: monsterAttackOptions(beast, content),
    armorClass: beast.armorClass,
    speed: beast.speed,
    traits: beast.traits,
    maxHp: beast.maxHp,
    hp: beast.maxHp,
    original: { attacks: hero.attacks, armorClass: hero.armorClass, speed: hero.speed, traits: hero.traits, maxHp: hero.maxHp, hp: hero.hp },
    ...(shapeSource(hero, content, beast) === "class" ? { spendsUseOf: wildShapeFeature } : (hero.concentration === null ? {} : { boundTo: hero.concentration.resolutionId })),
  });
  return null;
}

// Back to the hero's own stat block, at the hit points they had when they shaped.
export function revertWildShape(decision: Decision, hero: Combatant): void {
  const original = hero.wildShapeOriginal;
  if (original === null) return;
  decision.emit({
    kind: "wildShapeChanged",
    combatantId: hero.id,
    attacks: original.attacks,
    armorClass: original.armorClass,
    speed: original.speed,
    traits: original.traits,
    maxHp: original.maxHp,
    hp: Math.min(original.hp, original.maxHp),
    original: null,
  });
}
