import { checkModifier, isSkill, type CheckTest } from "../character/character-sheet.js";
import type { CharacterId } from "../core/ids.js";
import type { PlannedAction, PlannedEffect, RoundPlanProposal } from "../commands/campaign-command.js";
import { resolveRollMode } from "../dice/roll.js";
import { dcLadder, isDcTier, isRollModeReason, rollModeReasons } from "../rules/difficulty.js";
import { abilities } from "../rules/effects.js";
import type { CampaignState, CheckState, Resolution, RoundState } from "../state/campaign-state.js";
import { encounterProblems } from "./combat/combat-flow.js";
import { deadlineAfter, type Decision } from "./decision.js";
import { checkIdFor, rollIdFor, rollTimerId } from "./ids.js";
import type { Rejection } from "./rejection.js";
import { finishRoundIfResolved } from "./rounds.js";

// Applies the Planner's proposal for a closed round. The proposal comes from
// a model, so every value is checked at runtime even where the types already
// say it is valid; nothing applies unless the whole proposal is valid.
export function applyRoundPlan(decision: Decision, proposal: RoundPlanProposal): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "system") return { code: "systemOnly" };
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  const round = state.round;
  if (round?.status !== "planning" || round.number !== proposal.roundNumber) return { code: "stalePlan" };

  const problems = [...validateProposal(round, proposal), ...effectProblems(decision, proposal)];
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
    checks.push({
      id: checkId,
      roundNumber: round.number,
      characterId: action.characterId,
      test: plan.test,
      dcTier: plan.dcTier,
      dc: dcLadder[plan.dcTier],
      spec: {
        mode: resolveRollMode(
          directions.filter((direction) => direction === "advantage").length,
          directions.filter((direction) => direction === "disadvantage").length,
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
function effectProblems(decision: Decision, proposal: RoundPlanProposal): readonly string[] {
  const effects = proposal.effects ?? [];
  const problems: string[] = [];
  const count = (kind: PlannedEffect["effect"]["kind"]): number => effects.filter((planned) => planned.effect.kind === kind).length;
  if (count("transitionScene") > 1) problems.push("Only one scene transition per round.");
  if (count("startEncounter") > 1) problems.push("Only one encounter per round.");
  for (const { effect, when } of effects) {
    if (when.kind === "checkOutcome") {
      const action = proposal.actions.find((candidate) => candidate.characterId === when.characterId);
      if (action?.resolution.kind !== "check") problems.push(`${effect.kind} depends on ${when.characterId}, who has no check this round.`);
    }
    switch (effect.kind) {
      case "transitionScene":
        if (!/^scene:[a-z0-9-]+$/.test(effect.sceneId)) problems.push(`Scene ID "${effect.sceneId}" is malformed.`);
        break;
      case "startEncounter":
        problems.push(...encounterProblems(decision, effect.encounter).map((problem) => `Encounter ${effect.encounter.id}: ${problem}`));
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
      return (abilities as readonly string[]).includes(test.ability) ? [] : [`unknown ability "${test.ability}".`];
    case "skill":
      return isSkill(test.skill) ? [] : [`unknown skill "${String(test.skill)}".`];
    default:
      return ["unknown check kind."];
  }
}
