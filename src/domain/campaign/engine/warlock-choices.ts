import { classLevelsOf } from "../character/character-build.js";
import { invocationSlots, isInvocation, isPactBoon, pactBoonLevel } from "../character/warlock-choices.js";
import type { CharacterId } from "../core/ids.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

// A warlock picks Eldritch Invocations (as many as their level allows) and, from level 3, a Pact Boon. Like a Fighting Style, they
// are features on the sheet and may be swapped whenever the hero is not in a fight; the hero's owner (or the organizer) chooses.
export function chooseWarlockOptions(decision: Decision, characterId: CharacterId, invocations: readonly string[] | undefined, pactBoon: string | undefined): Rejection | null {
  const { state, ctx } = decision;
  const sheet = state.characters[characterId];
  if (sheet === undefined) return { code: "notYourCharacter" };
  if (ctx.actor.kind === "user" && ctx.actor.userId !== sheet.ownerUserId && ctx.actor.userId !== state.organizerId) return { code: "notYourCharacter" };
  if (state.encounter !== null && state.encounter.status !== "ended") return { code: "inCombat" };
  const level = classLevelsOf(sheet).warlock ?? 0;
  if (level < 2) return { code: "unknownFeature" };
  if (invocations === undefined && pactBoon === undefined) return { code: "unknownFeature" };
  if (invocations !== undefined && (!invocations.every(isInvocation) || new Set(invocations).size !== invocations.length || invocations.length > invocationSlots(level))) return { code: "unknownFeature" };
  if (pactBoon !== undefined && (!isPactBoon(pactBoon) || level < pactBoonLevel)) return { code: "unknownFeature" };
  decision.emit({
    kind: "warlockOptionsChosen",
    characterId,
    ...(invocations === undefined ? {} : { invocations }),
    ...(pactBoon === undefined ? {} : { pactBoon }),
  });
  return null;
}
