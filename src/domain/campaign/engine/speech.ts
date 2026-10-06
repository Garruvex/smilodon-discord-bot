import type { CharacterId } from "../core/ids.js";
import { isFallen } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

export const maxSpeechLength = 300;

// A hero's in-character words (panel spec: Speak). The table sees them as the
// hero's line and the DM hears them, but they are not an action: they use no
// action slot, budget, or resource, and cannot change any rule or result.
// Anyone with a living hero may speak while play is running.
export function speak(decision: Decision, characterId: CharacterId, text: string): Rejection | null {
  const { state, ctx } = decision;
  const sheet = state.characters[characterId];
  if (ctx.actor.kind !== "user" || sheet === undefined || sheet.ownerUserId !== ctx.actor.userId) return { code: "notYourCharacter" };
  if (state.status !== "active") return { code: "campaignWaiting" };
  if (isFallen(state, characterId)) return { code: "heroFallen" };
  const trimmed = text.trim();
  if (trimmed.length === 0) return { code: "emptyAction" };
  if (trimmed.length > maxSpeechLength) return { code: "actionTooLong", maxLength: maxSpeechLength };
  decision.emit({ kind: "heroSpoke", characterId, roundNumber: state.round?.number ?? state.lastRoundNumber, text: trimmed });
  decision.request({ kind: "deliver", delivery: { kind: "speech", characterId, text: trimmed } });
  return null;
}
