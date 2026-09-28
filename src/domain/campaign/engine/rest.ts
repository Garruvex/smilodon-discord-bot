import { abilityModifier } from "../character/character-sheet.js";
import { hitDicePool } from "../character/character-build.js";
import { defaultHeroResources, type HeroStatus } from "../character/hero-status.js";
import type { CharacterId } from "../core/ids.js";
import { isFallen } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

// Rests restore limited resources between fights (2014 rules). Short:
// features that recharge on a short rest, and Hit Dice are spent until the
// hero is at full HP or out of dice, each healing its average plus the
// Constitution modifier (no roll, so a rest is deterministic). Long: HP,
// spell slots, every feature, and half the Hit Dice back (at least one).
export function takeRest(decision: Decision, rest: "short" | "long"): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind === "user" && ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (state.encounter !== null && state.encounter.status !== "ended") return { code: "inCombat" };
  if (state.round !== null) return { code: "roundInProgress" };
  const content = ctx.rules.content;
  const heroStatus: Record<CharacterId, HeroStatus> = {};
  for (const sheet of Object.values(state.characters)) {
    if (isFallen(state, sheet.id)) continue;
    const fresh = defaultHeroResources(sheet, content);
    const current = state.heroStatus[sheet.id] ?? { hp: sheet.maxHp, resources: fresh };
    const dice = current.hitDice ?? sheet.level;
    if (rest === "long") {
      const hitDice = Math.min(sheet.level, dice + Math.max(1, Math.floor(sheet.level / 2)));
      // SRD 5.1: a long rest also removes one level of Exhaustion.
      const exhaustion = Math.max(0, (current.exhaustion ?? 0) - 1);
      heroStatus[sheet.id] = { hp: sheet.maxHp, resources: fresh, hitDice, exhaustion };
      continue;
    }
    // Largest die first (hitDicePool's own ordering): a multiclass hero's
    // remaining `dice` count is always the smallest-`dice` suffix of this
    // sorted pool, since every rest spends and restores largest-first too —
    // see hitDicePool's doc comment (character-build.ts).
    const pool = hitDicePool(sheet);
    let hp = current.hp;
    let left = dice;
    let spent = pool.length - dice;
    while (hp < sheet.maxHp && left > 0) {
      const die = pool[spent] ?? sheet.hitDie;
      hp = Math.min(sheet.maxHp, hp + Math.max(1, Math.floor(die / 2) + 1 + abilityModifier(sheet.abilityScores.con)));
      left -= 1;
      spent += 1;
    }
    const featureUses = { ...current.resources.featureUses };
    for (const id of sheet.features) {
      const feature = content.find(id);
      if (feature?.kind === "feature" && feature.action?.uses.recharge === "shortRest") featureUses[id] = feature.action.uses.count;
    }
    heroStatus[sheet.id] = { hp, resources: { ...current.resources, featureUses }, hitDice: left, exhaustion: current.exhaustion ?? 0 };
  }
  decision.emit({ kind: "restTaken", rest, heroStatus });
  return null;
}
