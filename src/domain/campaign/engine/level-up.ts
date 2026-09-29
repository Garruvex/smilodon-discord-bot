import type { CharacterId } from "../core/ids.js";
import { levelSteps, maxLevel, xpThresholds } from "../character/leveling.js";
import { isFallen } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

// Levels one hero up to `targetLevel`, one characterLeveledUp event per level.
// Shared by the two ways a hero levels: crossing an XP threshold after a
// fight, and the party being raised by hand or by a story milestone. A hero
// whose XP is short of the level they reach is lifted to that level's
// threshold, so a milestone level never reads as an XP mismatch later.
export function levelHeroTo(decision: Decision, characterId: CharacterId, targetLevel: number): void {
  const sheet = decision.state.characters[characterId];
  if (sheet === undefined) return;
  for (const next of levelSteps(sheet, targetLevel)) {
    const threshold = xpThresholds[next.level - 1] ?? 0;
    decision.emit({
      kind: "characterLeveledUp",
      characterId,
      level: next.level,
      maxHp: next.maxHp,
      abilityScores: next.abilityScores,
      spellcasting: next.spellcasting,
      features: next.features,
      classLevels: next.classLevels,
      skills: next.skills,
      pactMagic: next.pactMagic,
      ...(next.pendingAsi === undefined ? {} : { pendingAsi: next.pendingAsi }),
      ...((sheet.xp ?? 0) < threshold ? { xp: threshold } : {}),
    });
  }
}

// Brings every living hero below `level` up to it. Returns how many heroes
// actually gained a level.
export function raiseHeroesTo(decision: Decision, level: number): number {
  let raised = 0;
  for (const sheet of Object.values(decision.state.characters)) {
    if (isFallen(decision.state, sheet.id) || sheet.level >= level) continue;
    levelHeroTo(decision, sheet.id, level);
    if ((decision.state.characters[sheet.id]?.level ?? sheet.level) > sheet.level) raised += 1;
  }
  return raised;
}

// The organizer raises the party to `level` (milestone leveling, or a reward
// in an experience game). Not while a fight is on: a level gained mid-fight
// would not reach the combatants already built from the old sheets.
export function raisePartyLevel(decision: Decision, level: number): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind === "user" && ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (!Number.isInteger(level) || level < 2 || level > maxLevel) return { code: "invalidLevel" };
  if (state.encounter !== null && state.encounter.status !== "ended") return { code: "inCombat" };
  if (raiseHeroesTo(decision, level) === 0) return { code: "noLevelToRaise" };
  return null;
}
