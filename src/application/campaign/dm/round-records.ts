import type { CheckTest } from "../../../domain/campaign/character/character-sheet.js";
import type { CharacterId } from "../../../domain/campaign/core/ids.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import type { CheckResult, Resolution } from "../../../domain/campaign/state/campaign-state.js";

// What happened in one round, rebuilt from the event log: the source for the
// transcript layer and for the Narrator's outcome list.
export interface RoundRecord {
  readonly number: number;
  // Latest wording per hero, in the order heroes first acted.
  readonly actions: Map<CharacterId, string>;
  readonly passed: Set<CharacterId>;
  readonly missed: Set<CharacterId>;
  resolutions: Readonly<Record<CharacterId, Resolution>>;
  readonly checks: Map<string, { readonly test: CheckTest; readonly dc: number; result: CheckResult | null }>;
  narration: string | null;
}

export function roundRecords(events: readonly CampaignEvent[]): readonly RoundRecord[] {
  const rounds = new Map<number, RoundRecord>();
  const roundOf = (number: number): RoundRecord => {
    let record = rounds.get(number);
    if (record === undefined) {
      record = { number, actions: new Map(), passed: new Set(), missed: new Set(), resolutions: {}, checks: new Map(), narration: null };
      rounds.set(number, record);
    }
    return record;
  };
  const checkRounds = new Map<string, number>();

  for (const event of events) {
    switch (event.kind) {
      case "roundOpened":
        roundOf(event.roundNumber);
        break;
      case "actionSubmitted": {
        const record = roundOf(event.roundNumber);
        record.passed.delete(event.characterId);
        record.actions.set(event.characterId, event.text);
        break;
      }
      case "passSubmitted": {
        const record = roundOf(event.roundNumber);
        record.actions.delete(event.characterId);
        record.passed.add(event.characterId);
        break;
      }
      case "roundClosed":
        for (const characterId of event.missed) roundOf(event.roundNumber).missed.add(characterId);
        break;
      case "roundPlanApplied": {
        const record = roundOf(event.roundNumber);
        record.resolutions = event.resolutions;
        for (const check of event.checks) {
          record.checks.set(check.id, { test: check.test, dc: check.dc, result: null });
          checkRounds.set(check.id, event.roundNumber);
        }
        break;
      }
      case "checkResolved": {
        const number = checkRounds.get(event.checkId);
        const check = number === undefined ? undefined : rounds.get(number)?.checks.get(event.checkId);
        if (check !== undefined) check.result = event.result;
        break;
      }
      case "narrationRecorded":
        roundOf(event.roundNumber).narration = event.text;
        break;
      default:
        // Membership, timers, planner failures, and ledger facts are not
        // part of the round's story.
        break;
    }
  }
  return [...rounds.values()].sort((a, b) => a.number - b.number);
}

export function checkLabel(test: CheckTest): string {
  return test.kind === "skill" ? test.skill : `${test.ability} check`;
}
