import type { CharacterId, CheckId, RollId, TimerId } from "../core/ids.js";

// IDs the engine creates are derived from what they identify, so decide()
// stays deterministic and a retried command produces the same IDs.
export function checkIdFor(roundNumber: number, characterId: CharacterId): CheckId {
  return `r${roundNumber}:${characterId}`;
}

export function rollIdFor(checkId: CheckId): RollId {
  return `${checkId}:roll`;
}

// A retried fight runs under "<id>~2", "<id>~3", ... so its rolls are new;
// the adventure still knows it by the base ID.
export function baseEncounterId(encounterId: string): string {
  return encounterId.replace(/~\d+$/, "");
}

export function retryEncounterId(encounterId: string): string {
  const attempt = /~(\d+)$/.exec(encounterId)?.[1];
  return `${baseEncounterId(encounterId)}~${attempt === undefined ? 2 : Number(attempt) + 1}`;
}

export function roundTimerId(roundNumber: number): TimerId {
  return `round:${roundNumber}`;
}

export function rollTimerId(checkId: CheckId): TimerId {
  return `roll:${checkId}`;
}
