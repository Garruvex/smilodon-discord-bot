import { takeEnvironmentalDamage } from "./environmental-damage.js";
import type { TravelCommand } from "../commands/campaign-command.js";
import { savingThrowModifier } from "../character/character-sheet.js";
import { defaultHeroResources } from "../character/hero-status.js";
import type { CharacterId } from "../core/ids.js";
import { resolveD20Test, rollMatchesSpec } from "../dice/d20-test.js";
import { classifyRollMoments } from "../dice/roll-moments.js";
import { resolveRollMode } from "../dice/roll.js";
import type { RollResult } from "../dice/roll-spec.js";
import { naturalRollsOnChecks } from "../rules/house-rules.js";
import type { Ability } from "../rules/effects.js";
import { isFallen, type HazardRecord, type PendingHazard } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

// A travel or environmental hazard outside a fight: a forced march, extreme
// weather, harsh terrain (DMG's own shape for all three — a saving throw
// against a DC, a level of Exhaustion on a failure, nothing on a success).
// The organizer names the ability and DC, narrating the terrain themselves
// (the engine has no bible to look either up from, the same trust boundary
// an EncounterSpec's zones and monsters already have); a real d20 always
// decides the cost, never the model's own call about how harsh the journey was.
export function handleTravelCommand(decision: Decision, command: TravelCommand): Rejection | null {
  switch (command.kind) {
    case "faceHazard":
      return faceHazard(decision, command.characterId, command.ability, command.dc);
    case "recordHazardNarration":
      return recordHazardNarration(decision, command.hazardId, command.text);
    case "takeEnvironmentalDamage":
      return takeEnvironmentalDamage(decision, command.characterId, command.source);
  }
}

function faceHazard(decision: Decision, characterId: CharacterId, ability: Ability, dc: number): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind === "user" && ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (isFallen(state, characterId)) return { code: "heroFallen" };
  if (state.encounter !== null && state.encounter.status !== "ended") return { code: "inCombat" };
  if (state.hazardPending?.[characterId] !== undefined) return { code: "hazardAlreadyPending" };
  const sheet = state.characters[characterId];
  if (sheet === undefined) return { code: "notYourCharacter" };

  // The same mechanical disadvantage every ability check and save carries at
  // Exhaustion 1+ (round-plan.ts, engine/shop.ts's haggle, engine/dialogue.ts's
  // press all apply it too).
  const exhaustionPenalty = (state.heroStatus[characterId]?.exhaustion ?? 0) >= 1 ? 1 : 0;
  const hazard: PendingHazard = {
    characterId,
    ability,
    dc,
    spec: { mode: resolveRollMode(0, exhaustionPenalty), modifier: savingThrowModifier(sheet, ability), bonusDice: [] },
    rollId: `hazard-roll:${characterId}:${state.hazardCount + 1}`,
  };
  decision.emit({ kind: "hazardStarted", hazard });
  decision.request({ kind: "roll", rollId: hazard.rollId, spec: { kind: "d20Test", spec: hazard.spec } });
  return null;
}

// The roll worker saved a result for a pending hazard (decide.ts's
// recordRoll dispatcher tries this after round-plan checks, a pending
// haggle, and a pending press). A failure costs one level of Exhaustion,
// applied here in the settling event, not narrated into existence later.
export function recordHazardRoll(decision: Decision, hazard: PendingHazard, result: RollResult): Rejection | null {
  if (result.kind !== "d20Test" || !rollMatchesSpec(result.roll, hazard.spec)) return { code: "rollMismatch" };
  const { ctx, state } = decision;
  const naturalRule = ctx.rules.houseRules.option(naturalRollsOnChecks);
  const outcome = resolveD20Test("savingThrow", result.roll.d20.natural, result.roll.total, hazard.dc, naturalRule);
  const moments = classifyRollMoments({ kind: "savingThrow", roll: result.roll, target: hazard.dc, naturalRule });
  const exhaustionGained = outcome.success ? 0 : 1;
  const record: HazardRecord = {
    id: `hazard:${state.hazardCount + 1}`,
    characterId: hazard.characterId,
    ability: hazard.ability,
    dc: hazard.dc,
    total: result.roll.total,
    success: outcome.success,
    moments,
    exhaustionGained,
  };
  // A hero who never fought or rested yet has no heroStatus entry at all
  // (members.ts's joinHero doesn't create one); default it here the same
  // way engine/rest.ts does, rather than let evolve() guess — evolve() is
  // pure and has no content to build default resources from.
  const sheet = state.characters[hazard.characterId];
  const current = sheet === undefined ? undefined : (state.heroStatus[hazard.characterId] ?? { hp: sheet.maxHp, resources: defaultHeroResources(sheet, ctx.rules.content) });
  const heroStatus = current === undefined ? undefined : { ...current, exhaustion: Math.min(6, (current.exhaustion ?? 0) + exhaustionGained) };
  decision.emit({ kind: "hazardSettled", hazard: record, ...(heroStatus === undefined ? {} : { heroStatus }) });
  decision.request({ kind: "narrateHazard", hazardId: record.id });
  return null;
}

function recordHazardNarration(decision: Decision, hazardId: string, text: string): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { code: "emptyNarration" };
  if (state.hazards[hazardId] === undefined) return { code: "staleNarration" };
  decision.emit({ kind: "hazardNarrated", hazardId, text: trimmed });
  decision.request({ kind: "deliver", delivery: { kind: "hazardNarrated", hazardId } });
  return null;
}
