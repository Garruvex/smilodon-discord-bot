import type { PartyEffect, PlannedEffect } from "../commands/campaign-command.js";
import type { SceneId } from "../adventure/adventure-bible.js";
import type { UserId } from "../core/ids.js";
import { presentMembers, type CampaignState } from "../state/campaign-state.js";
import type { Decision } from "./decision.js";
import type { Rejection } from "./rejection.js";

// A scene change the Planner proposes waits for the table instead of happening
// at once. Silence agrees. The move settles when the next round closes: the
// party goes unless more than half of the present players pressed Stay, and a
// tie stays. The party cannot split, so an outvoted player's hero goes along.

const isPartyEffect = (effect: PlannedEffect["effect"]): effect is PartyEffect => effect.kind !== "hurt";

// The fired effects that belong to a move the table has not agreed to: the
// scene change itself and what arriving brings. Empty when nothing is proposed
// or the story forces the move.
export function deferredMove(fired: readonly PlannedEffect[]): readonly PlannedEffect[] {
  const move = fired.find((planned) => planned.effect.kind === "transitionScene" && planned.forced !== true);
  if (move === undefined || move.effect.kind !== "transitionScene") return [];
  const sceneId = move.effect.sceneId;
  return fired.filter((planned) => planned === move || planned.arrivalOf === sceneId);
}

// A second move that fired in the same round (the checks decided two branches at once): the party can only head one way, so the
// first stands and the other, with what arriving there would have brought, is dropped.
export function surplusMove(fired: readonly PlannedEffect[], held: readonly PlannedEffect[]): readonly PlannedEffect[] {
  const extra = fired.filter((planned) => planned.effect.kind === "transitionScene" && planned.forced !== true && !held.includes(planned));
  const dropped = new Set(extra.flatMap((planned) => (planned.effect.kind === "transitionScene" ? [planned.effect.sceneId] : [])));
  return fired.filter((planned) => extra.includes(planned) || (planned.arrivalOf !== undefined && dropped.has(planned.arrivalOf) && !held.includes(planned)));
}

// Holds a proposed move for the table. A repeat of the move already waiting
// changes nothing, so objections stand; a different one replaces it.
export function proposeMove(decision: Decision, roundNumber: number, deferred: readonly PlannedEffect[]): void {
  const move = deferred.find((planned) => planned.effect.kind === "transitionScene");
  if (move === undefined || move.effect.kind !== "transitionScene") return;
  const { sceneId } = move.effect;
  if (decision.state.pendingMove?.sceneId === sceneId) return;
  // The table already said no to this room: only a player's suggestion or the story brings it back.
  if (decision.state.sceneMoveDeclinedScene === sceneId) return;
  // The party moves together: one hero's wish does not send everyone. Heroes who act are counted from the round in progress.
  const submissions = Object.values(decision.state.round?.submissions ?? {}).filter((submission) => submission.kind === "action").length;
  const movers = move.movers ?? [];
  if (movers.length > 0 && movers.length * 2 < submissions) return;
  const effects = [move, ...deferred.filter((planned) => planned !== move)].map((planned) => planned.effect).filter(isPartyEffect);
  decision.emit({ kind: "sceneMoveProposed", roundNumber, sceneId, effects, ...(movers.length === 0 ? {} : { heroes: movers }) });
}

// A player suggests a scene. It waits for the table like any other move, and the window that answers it is the round in progress:
// it settles as that round closes. (A move the Planner proposes was settled a round later, since its round was already over.)
export function proposeMoveByPlayer(decision: Decision, sceneId: SceneId, effects: readonly PartyEffect[]): Rejection | null {
  const userId = presentPlayer(decision);
  if (typeof userId !== "string") return userId;
  const { state } = decision;
  if (state.status === "waitingForPlayers") return { code: "campaignWaiting" };
  if ((state.encounter !== null && state.encounter.status !== "ended") || state.pendingEncounter !== null) return { code: "inCombat" };
  const first = effects[0];
  if (sceneId === state.sceneId || first?.kind !== "transitionScene" || first.sceneId !== sceneId) return { code: "invalidMove" };
  if (state.pendingMove?.sceneId === sceneId) return null;
  const roundNumber = state.round === null ? state.lastRoundNumber : state.round.number - 1;
  const hero = state.members[userId]?.characterId;
  decision.emit({ kind: "sceneMoveProposed", roundNumber, sceneId, effects, by: userId, ...(hero === null || hero === undefined ? {} : { heroes: [hero] }) });
  return null;
}

export function objectToMove(decision: Decision): Rejection | null {
  const userId = presentPlayer(decision);
  if (typeof userId !== "string") return userId;
  const { pendingMove } = decision.state;
  if (pendingMove === undefined) return { code: "noPendingMove" };
  if (pendingMove.supporters?.includes(userId)) decision.emit({ kind: "sceneMoveSupportWithdrawn", userId });
  if (!pendingMove.objectors.includes(userId)) decision.emit({ kind: "sceneMoveObjected", userId });
  // Enough have pressed Stay that waiting cannot change the answer (silence only ever adds Go): settle now, and the round carries on.
  const { pendingMove: current } = decision.state;
  if (current !== undefined && stays(decision.state, current.objectors)) settle(decision, decision.state.round?.number ?? decision.state.lastRoundNumber, "stay", "table");
  return null;
}

export function supportMove(decision: Decision): Rejection | null {
  const userId = presentPlayer(decision);
  if (typeof userId !== "string") return userId;
  const { pendingMove } = decision.state;
  if (pendingMove === undefined) return { code: "noPendingMove" };
  if (!pendingMove.supporters?.includes(userId)) decision.emit({ kind: "sceneMoveSupported", userId });
  // A unanimous explicit Go vote is already a complete decision; do not make
  // the table wait for the round timer just because silence also defaults to Go.
  const current = decision.state.pendingMove;
  const present = presentMembers(decision.state).map((member) => member.userId);
  if (current !== undefined && present.length > 0 && present.every((id) => current.supporters?.includes(id))) {
    settle(decision, decision.state.round?.number ?? decision.state.lastRoundNumber, "go", "table");
  }
  return null;
}

export function withdrawMoveSupport(decision: Decision): Rejection | null {
  const userId = presentPlayer(decision);
  if (typeof userId !== "string") return userId;
  const { pendingMove } = decision.state;
  if (pendingMove === undefined) return { code: "noPendingMove" };
  if (pendingMove.supporters?.includes(userId)) decision.emit({ kind: "sceneMoveSupportWithdrawn", userId });
  return null;
}

export function withdrawObjection(decision: Decision): Rejection | null {
  const userId = presentPlayer(decision);
  if (typeof userId !== "string") return userId;
  const { pendingMove } = decision.state;
  if (pendingMove === undefined) return { code: "noPendingMove" };
  if (pendingMove.objectors.includes(userId)) decision.emit({ kind: "sceneMoveObjectionWithdrawn", userId });
  return null;
}

export function settleMoveByOrganizer(decision: Decision, outcome: "go" | "stay"): Rejection | null {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user" || ctx.actor.userId !== state.organizerId) return { code: "notOrganizer" };
  if (state.pendingMove === undefined) return { code: "noPendingMove" };
  settle(decision, state.round?.number ?? state.lastRoundNumber, outcome, "organizer");
  return null;
}

// Called as a round closes. A move proposed in an earlier round has had a full
// window to be answered, so it settles now, before the Planner sees this
// round's actions.
export function settleDueMove(decision: Decision, closingRound: number): void {
  const { pendingMove } = decision.state;
  if (pendingMove === undefined || pendingMove.proposedRound >= closingRound) return;
  settle(decision, closingRound, stays(decision.state, pendingMove.objectors) ? "stay" : "go", "table");
}

function stays(state: CampaignState, objectors: readonly UserId[]): boolean {
  const present = new Set(presentMembers(state).map((member) => member.userId));
  const against = objectors.filter((userId) => present.has(userId)).length;
  return against > 0 && against * 2 >= present.size;
}

function settle(decision: Decision, roundNumber: number, outcome: "go" | "stay", by: "table" | "organizer"): void {
  const pending = decision.state.pendingMove;
  if (pending === undefined) return;
  const { sceneId, objectors, effects } = pending;
  if (outcome === "stay") {
    decision.emit({ kind: "sceneMoveDeclined", roundNumber, sceneId, objectors, by });
    return;
  }
  decision.emit({ kind: "sceneMoveAgreed", roundNumber, sceneId, objectors, by });
  for (const effect of effects) decision.applyStory(roundNumber, effect, by === "organizer" ? "organizer" : "agreed");
}

function presentPlayer(decision: Decision): UserId | Rejection {
  const { state, ctx } = decision;
  if (ctx.actor.kind !== "user") return { code: "notMember" };
  const member = state.members[ctx.actor.userId];
  if (member === undefined) return { code: "notMember" };
  if (member.availability === "away") return { code: "memberAway" };
  return member.userId;
}
