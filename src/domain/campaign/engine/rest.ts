import { defaultHeroResources, type HeroStatus } from "../combat/combatant-profile.js";
import type { CharacterId } from "../core/ids.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

// Rests restore limited resources between fights (2014 rules, simplified:
// Hit Dice are not modeled yet). Short: features that recharge on a short
// rest. Long: HP, spell slots, and every feature.
export function takeRest(decision: Decision, rest: "short" | "long"): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind === "user" && ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (state.encounter !== null && state.encounter.status !== "ended") return { code: "inCombat" };
  if (state.round !== null) return { code: "roundInProgress" };
  const content = ctx.rules.content;
  const heroStatus: Record<CharacterId, HeroStatus> = {};
  for (const sheet of Object.values(state.characters)) {
    const fresh = defaultHeroResources(sheet, content);
    const current = state.heroStatus[sheet.id] ?? { hp: sheet.maxHp, resources: fresh };
    if (rest === "long") {
      heroStatus[sheet.id] = { hp: sheet.maxHp, resources: fresh };
      continue;
    }
    const featureUses = { ...current.resources.featureUses };
    for (const id of sheet.features) {
      const feature = content.find(id);
      if (feature?.kind === "feature" && feature.action?.uses.recharge === "shortRest") featureUses[id] = feature.action.uses.count;
    }
    heroStatus[sheet.id] = { hp: current.hp, resources: { ...current.resources, featureUses } };
  }
  decision.emit({ kind: "restTaken", rest, heroStatus });
  return null;
}
