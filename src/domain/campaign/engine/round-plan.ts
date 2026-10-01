import { checkModifier, isSkill, type CheckTest } from "../character/character-sheet.js";
import type { CharacterId } from "../core/ids.js";
import type { EncounterSpec, PlannedAction, PlannedEffect, RoundPlanProposal } from "../commands/campaign-command.js";
import { resolveRollMode } from "../dice/roll.js";
import { hasStealthDisadvantage } from "./gear.js";
import { dcLadder, isDcTier, isRollModeReason, rollModeReasons } from "../rules/difficulty.js";
import { abilities } from "../rules/effects.js";
import type { CampaignState, CheckState, Resolution, RoundState } from "../state/campaign-state.js";
import { deadlineAfter, type Decision } from "./decision.js";
import { checkIdFor, rollIdFor, rollTimerId } from "./ids.js";
import type { Rejection } from "./rejection.js";
import { scheduleReminder } from "./reminders.js";
import { finishRoundIfResolved } from "./rounds.js";

// Applies the Planner's proposal for a closed round. The proposal comes from
// a model, so every value is checked at runtime even where the types already
// say it is valid; nothing applies unless the whole proposal is valid.
// Whether a fight the plan would start is valid: Combat's rule, passed in by the caller.
export type EncounterCheck = (decision: Decision, spec: EncounterSpec) => readonly string[];

export function applyRoundPlan(decision: Decision, proposal: RoundPlanProposal, checkEncounter: EncounterCheck): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  const round = state.round;
  if (round?.status !== "planning" || round.number !== proposal.roundNumber) return { code: "stalePlan" };

  const problems = [...validateProposal(round, proposal), ...effectProblems(decision, proposal, checkEncounter)];
  if (problems.length > 0) return { code: "invalidPlan", problems };

  const resolutions: Record<CharacterId, Resolution> = {};
  const checks: CheckState[] = [];
  for (const action of proposal.actions) {
    const plan = action.resolution;
    if (plan.kind !== "check") {
      resolutions[action.characterId] = { kind: plan.kind, reason: plan.reason.trim() };
      continue;
    }
    const sheet = state.characters[action.characterId];
    if (sheet === undefined) continue; // Unreachable: participants always have sheets.
    const checkId = checkIdFor(round.number, action.characterId);
    const directions = plan.rollModeReasons.map((reason) => rollModeReasons[reason]);
    // Stealth disadvantage from worn armor, and Exhaustion 1+'s disadvantage
    // on every ability check, are mechanical — not something the Planner has
    // to notice and cite as a reason (unlike its own rollModeReasons).
    const armorStealthPenalty = plan.test.kind === "skill" && plan.test.skill === "stealth" && hasStealthDisadvantage(sheet, ctx.rules.content) ? 1 : 0;
    const exhaustionPenalty = plan.test.kind !== "save" && (state.heroStatus[action.characterId]?.exhaustion ?? 0) >= 1 ? 1 : 0;
    checks.push({
      id: checkId,
      roundNumber: round.number,
      characterId: action.characterId,
      test: plan.test,
      dcTier: plan.dcTier,
      dc: plan.dc ?? dcLadder[plan.dcTier],
      spec: {
        mode: resolveRollMode(
          directions.filter((direction) => direction === "advantage").length,
          directions.filter((direction) => direction === "disadvantage").length + armorStealthPenalty + exhaustionPenalty,
        ),
        modifier: checkModifier(sheet, plan.test),
        bonusDice: [],
      },
      deadline: deadlineAfter(ctx.now, state.pacing.rollSeconds),
      status: "pending",
      rollId: rollIdFor(checkId),
      timedOut: false,
      result: null,
    });
    resolutions[action.characterId] = { kind: "check", checkId };
  }

  decision.emit({ kind: "roundPlanApplied", roundNumber: round.number, resolutions, checks, effects: proposal.effects ?? [] });
  for (const check of checks) {
    if (check.deadline !== null) {
      decision.request({
        kind: "startTimer",
        timer: { kind: "roll", timerId: rollTimerId(check.id), dueAt: check.deadline, checkId: check.id },
      });
      scheduleReminder(decision, { kind: "roll", checkId: check.id, deadline: check.deadline });
    }
  }
  finishRoundIfResolved(decision);
  return null;
}

// Every problem at once, so a retry prompt can list them all.
export function validateProposal(round: RoundState, proposal: RoundPlanProposal): readonly string[] {
  const problems: string[] = [];
  const planned = new Set<CharacterId>();
  for (const action of proposal.actions) {
    const who = action.characterId;
    if (planned.has(who)) problems.push(`${who}: planned more than once.`);
    planned.add(who);
    if (round.submissions[who]?.kind !== "action") {
      problems.push(`${who}: has no submitted action this round.`);
      continue;
    }
    problems.push(...resolutionProblems(action));
  }
  for (const [characterId, submission] of Object.entries(round.submissions)) {
    if (submission.kind === "action" && !planned.has(characterId)) problems.push(`${characterId}: action was not planned.`);
  }
  return problems;
}

// At most one scene change and one fight per round; a conditional effect
// must hang on a check this proposal actually asks for.
function effectProblems(decision: Decision, proposal: RoundPlanProposal, checkEncounter: EncounterCheck): readonly string[] {
  const effects = proposal.effects ?? [];
  const problems: string[] = [];
  const count = (kind: PlannedEffect["effect"]["kind"]): number => effects.filter((planned) => planned.effect.kind === kind).length;
  // Several moves are fine when the checks decide between them (success one way, failure another); only one may fire, see rounds.ts.
  if (effects.filter((planned) => planned.effect.kind === "transitionScene" && planned.when.kind === "always").length > 1) problems.push("Only one scene transition per round.");
  if (count("startEncounter") > 1) problems.push("Only one encounter per round.");
  const clocks = effects.flatMap(({ effect }) => (effect.kind === "advanceClock" ? [effect.clockId] : []));
  if (new Set(clocks).size !== clocks.length) problems.push("Advance each clock at most once per round.");
  for (const { effect, when } of effects) {
    if (when.kind === "groupCheck" && proposal.actions.filter((candidate) => candidate.resolution.kind === "check").length < 2) problems.push(`${effect.kind} depends on a group check, which needs at least two checks this round.`);
    if (when.kind === "anyCheck") {
      for (const characterId of when.characterIds) {
        if (proposal.actions.find((candidate) => candidate.characterId === characterId)?.resolution.kind !== "check") problems.push(`${effect.kind} depends on ${characterId}, who has no check this round.`);
      }
      if (when.characterIds.length === 0) problems.push(`${effect.kind} depends on no one's check.`);
    }
    if (when.kind === "checkOutcome") {
      const action = proposal.actions.find((candidate) => candidate.characterId === when.characterId);
      if (action?.resolution.kind !== "check") problems.push(`${effect.kind} depends on ${when.characterId}, who has no check this round.`);
    }
    switch (effect.kind) {
      case "transitionScene":
        if (!/^scene:[a-z0-9-]+$/.test(effect.sceneId)) problems.push(`Scene ID "${effect.sceneId}" is malformed.`);
        break;
      case "startEncounter":
        problems.push(...checkEncounter(decision, effect.encounter).map((problem) => `Encounter ${effect.encounter.id}: ${problem}`));
        break;
      case "advanceClock":
        if (!Number.isInteger(effect.by) || effect.by < 1 || effect.by > 3) problems.push(`Clock ${effect.clockId} may advance by 1 to 3 segments.`);
        if (!Number.isInteger(effect.segments) || effect.segments < 2) problems.push(`Clock ${effect.clockId} needs at least 2 segments.`);
        if (effect.onFull !== null) problems.push(...checkEncounter(decision, effect.onFull).map((problem) => `Clock ${effect.clockId} encounter ${effect.onFull?.id ?? ""}: ${problem}`));
        break;
      case "revealClue":
        if (effect.text.trim().length === 0) problems.push(`Clue ${effect.clueId} needs text.`);
        break;
      case "setFlag":
        if (!/^[a-z0-9:_-]{1,80}$/.test(effect.flag) || !Number.isInteger(effect.value) || effect.value < 0 || effect.value > 1000) problems.push(`Flag "${effect.flag}" is malformed.`);
        break;
      case "grantReward":
        if (!Number.isInteger(effect.gold) || effect.gold < 0 || effect.gold > 100_000 || effect.items.length > 20 || (effect.gold === 0 && effect.items.length === 0)) problems.push(`Reward ${effect.rewardId} is empty or out of range.`);
        break;
      case "spendGold":
        if (!Number.isInteger(effect.amount) || effect.amount < 1 || effect.amount > 100_000) problems.push(`A payment of ${effect.amount} gold is out of range.`);
        break;
      case "notice":
        if (effect.noticeId.trim().length === 0 || effect.text.trim().length === 0 || effect.text.length > 1500) problems.push(`Notice ${effect.noticeId} needs an id and text of at most 1500 characters.`);
        break;
      case "grantKeepsake":
        if (!/^[a-z0-9-]{1,60}$/.test(effect.keepsake.id) || effect.keepsake.name.trim().length === 0 || effect.keepsake.description.trim().length === 0) problems.push(`Keepsake ${effect.keepsake.id} needs an id, a name and a description.`);
        break;
      case "advanceTime":
        problems.push(...[decision.worldProblem({ kind: "advance", steps: effect.steps })].filter((problem) => problem !== null));
        break;
      case "setWeather":
        problems.push(...[decision.worldProblem({ kind: "weather", weather: effect.weather })].filter((problem) => problem !== null));
        break;
      case "hurt":
        if (!Number.isInteger(effect.count) || effect.count < 1 || effect.count > 20 || ![4, 6, 8, 10, 12].includes(effect.sides)) problems.push(`Harm of ${effect.count}d${effect.sides} is out of range.`);
        if (decision.state.characters[effect.characterId] === undefined) problems.push(`Harm names ${effect.characterId}, who is not a hero here.`);
        break;
      default:
        problems.push("Unknown story effect.");
    }
  }
  return problems;
}

// The effects whose condition held, in the order they were proposed.
export function firedEffects(state: CampaignState, round: RoundState): readonly PlannedEffect[] {
  return round.effects.filter(({ when }) => {
    if (when.kind === "always") return true;
    if (when.kind === "groupCheck") {
      const made = Object.values(state.checks).filter((candidate) => candidate.roundNumber === round.number && candidate.result != null);
      const passed = made.filter((candidate) => candidate.result?.success === true).length;
      return made.length > 0 && (passed * 2 >= made.length) === when.success;
    }
    if (when.kind === "anyCheck") {
      const results = when.characterIds.flatMap((characterId) => {
        const result = Object.values(state.checks).find((candidate) => candidate.roundNumber === round.number && candidate.characterId === characterId)?.result;
        return result == null ? [] : [result];
      });
      if (results.length === 0) return false;
      if (!when.success) return results.every((result) => !result.success);
      return results.some((result) => result.success && (when.atLeast === undefined || result.roll.total >= when.atLeast));
    }
    const check = Object.values(state.checks).find((candidate) => candidate.roundNumber === round.number && candidate.characterId === when.characterId);
    return check?.result != null && check.result.success === when.success;
  });
}

function resolutionProblems(action: PlannedAction): readonly string[] {
  const who = action.characterId;
  const plan = action.resolution;
  switch (plan.kind) {
    case "automatic":
    case "impossible":
      return plan.reason.trim().length === 0 ? [`${who}: ${plan.kind} needs a reason.`] : [];
    case "check": {
      const problems = testProblems(plan.test).map((problem) => `${who}: ${problem}`);
      if (plan.dc !== undefined && (!Number.isInteger(plan.dc) || plan.dc < 1 || plan.dc > 30)) problems.push(`${who}: DC ${plan.dc} is out of range.`);
      if (!isDcTier(plan.dcTier)) problems.push(`${who}: DC tier "${String(plan.dcTier)}" is not on the ladder.`);
      for (const reason of plan.rollModeReasons) {
        if (!isRollModeReason(reason)) problems.push(`${who}: unknown advantage reason "${String(reason)}".`);
      }
      if (new Set(plan.rollModeReasons).size !== plan.rollModeReasons.length) {
        problems.push(`${who}: advantage reasons repeat.`);
      }
      return problems;
    }
    default:
      return [`${who}: unknown resolution.`];
  }
}

function testProblems(test: CheckTest): readonly string[] {
  switch (test.kind) {
    case "ability":
    case "save":
      return (abilities as readonly string[]).includes(test.ability) ? [] : [`unknown ability "${test.ability}".`];
    case "skill":
      return isSkill(test.skill) ? [] : [`unknown skill "${String(test.skill)}".`];
    default:
      return ["unknown check kind."];
  }
}
