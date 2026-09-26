import type { CharacterId, CheckId, RollId, TimerId } from "../core/ids.js";

// IDs the engine creates are derived from what they identify, so decide()
// stays deterministic and a retried command produces the same IDs.
export function checkIdFor(roundNumber: number, characterId: CharacterId): CheckId {
  return `r${roundNumber}:${characterId}`;
}

export function rollIdFor(checkId: CheckId): RollId {
  return `${checkId}:roll`;
}

export function roundTimerId(roundNumber: number): TimerId {
  return `round:${roundNumber}`;
}

export function rollTimerId(checkId: CheckId): TimerId {
  return `roll:${checkId}`;
}
