import type { CharacterId } from "../core/ids.js";
import { isFallen } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

// Who may cast outside a fight: the hero's own player, while the hero still stands and no fight is on.
export function mayCastOutsideCombat(decision: Decision, characterId: CharacterId): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user" || state.characters[characterId]?.ownerUserId !== ctx.actor.userId) return { code: "notYourCharacter" };
  if (isFallen(state, characterId)) return { code: "heroFallen" };
  if (state.encounter !== null && state.encounter.status !== "ended") return { code: "inCombat" };
  return null;
}
