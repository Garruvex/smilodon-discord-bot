// Wild Shape (Druid, level 2): borrows a beast's stat block for combat
// purposes as a bonus action, and reverts to the hero's own the same way.
//
// Simplified, all documented at the point they matter (turn-rules.ts's
// wildShapeProblem and spellProblem, this file): only the Wolf is ever
// offered; there is no per-rest use limit (SRD: two uses, refreshing on a
// rest); a hero's class features besides spellcasting (Sneak Attack, Extra
// Attack, and so on) are left untouched rather than checked against the
// new form, since the milestone 0 roster has nothing that would conflict;
// and damage that would take the beast form below 0 HP does not carry over
// to the hero's own hit points the way the SRD says it should — it simply
// reverts them there at 0, the same liberty "protected while away" already
// takes for a downed hero.
import { monsterAttackOptions } from "../../combat/combatant-profile.js";
import type { Combatant } from "../../combat/combat-state.js";
import { costProblem, wildShapeProblem } from "../../combat/turn-rules.js";
import type { ContentId } from "../../rules/content-id.js";
import type { Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";

export function wildShape(decision: Decision, hero: Combatant, monsterId: ContentId<"monster"> | undefined): Rejection | null {
  const content = decision.ctx.rules.content;
  const problem = wildShapeProblem(hero, content, monsterId);
  if (problem !== null) return problem;
  const cost = costProblem(hero, "bonusAction", content);
  if (cost !== null) return cost;

  if (monsterId === undefined) {
    const original = hero.wildShapeOriginal;
    if (original === null) return { code: "notShaped" }; // Unreachable: wildShapeProblem already checked this.
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
  });
  return null;
}
