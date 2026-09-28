import type { D20TestRoll } from "../../dice/d20-test.js";
import { availableSlots, type PendingReaction, type Combatant, type EncounterState, type ResolutionState } from "../../combat/combat-state.js";
import { canReact, conditionLookup } from "../../effects/effect-queries.js";
import { lowestSlot } from "../../magic/spell-rules.js";
import type { ContentId } from "../../rules/content-id.js";
import type { SealedContent } from "../../rules/content-registry.js";
import { deadlineAfter, type Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { activeEncounter, isPlayerControlled, mayActFor } from "./combat-flow.js";
import { settleCheck } from "./resolution.js";

// Reactions (SRD 5.1: Shield). When an attack roll hits a creature that could
// turn the hit into a miss, the hit is not final yet: a window opens in which its
// player may cast the reaction spell or decline. The attack roll stays saved, the
// resolution goes no further until the answer (or the timer, which declines), and
// then the hit is settled again against the armor class the answer produced.

export const reactionTimerId = (resolutionId: string, rollId: string): string => `reaction:${resolutionId}:${rollId}`;

// The reaction spells this creature could cast now, each at the lowest slot that fits.
export function reactionOptions(target: Combatant, content: SealedContent): PendingReaction["options"] {
  const casting = target.spellcasting;
  if (target.source.kind !== "hero" || casting === null || !canReact(target, conditionLookup(content))) return [];
  return casting.spells.flatMap((id) => {
    const spell = content.find(id);
    if (spell?.kind !== "spell" || spell.reaction === undefined) return [];
    const slotLevel = lowestSlot(spell, availableSlots(target.resources));
    return slotLevel === undefined ? [] : [{ spellId: spell.id, slotLevel }];
  });
}

// An attack roll landed: opens the window when the hit could still be turned into a
// miss and the target's player is at the table. True when it did (the caller stops).
export function offerReaction(decision: Decision, encounter: EncounterState, resolution: ResolutionState, rollId: string, roll: D20TestRoll, against: number): boolean {
  const check = resolution.checks[rollId];
  const target = check === undefined ? undefined : encounter.combatants[check.targetId];
  if (check === undefined || target === undefined || !isPlayerControlled(decision, target)) return false;
  const content = decision.ctx.rules.content;
  const options = reactionOptions(target, content);
  const bonus = Math.max(
    0,
    ...options.map((option) => {
      const spell = content.find(option.spellId);
      return spell?.kind === "spell" && spell.reaction?.kind === "acBonusUntilNextTurn" ? spell.reaction.bonus : 0;
    }),
  );
  // Nothing they could cast would change this hit: no need to ask.
  if (options.length === 0 || roll.total >= against + bonus) return false;
  const closesAt = deadlineAfter(decision.ctx.now, decision.state.pacing.turnSeconds);
  decision.emit({ kind: "reactionOffered", resolutionId: resolution.id, reaction: { rollId, targetId: target.id, roll, options, closesAt } });
  decision.request({ kind: "deliver", delivery: { kind: "reactionOffered", encounterId: encounter.id, attackId: resolution.id } });
  if (closesAt !== null) {
    decision.request({ kind: "startTimer", timer: { kind: "combatReaction", timerId: reactionTimerId(resolution.id, rollId), dueAt: closesAt, encounterId: encounter.id, resolutionId: resolution.id } });
  }
  return true;
}

// The target's player answers: a reaction spell, or null to decline. "system" answers
// for a timer or an away player and is always a decline.
export function answerReaction(decision: Decision, combatantId: string, spellId: ContentId<"spell"> | null, by: "player" | "system"): Rejection | null {
  const encounter = activeEncounter(decision);
  const resolution = encounter?.resolution;
  const pending = resolution?.reaction;
  if (encounter == null || resolution == null || pending == null || pending.targetId !== combatantId) return { code: "noReaction" };
  // While play is stopped the window waits; it gets a fresh timer when play resumes.
  if (by === "player" && decision.state.status !== "active") return { code: "campaignWaiting" };
  const target = encounter.combatants[combatantId];
  if (target === undefined || target.source.kind !== "hero") return { code: "noReaction" };
  if (by === "player" && !mayActFor(decision, target)) return { code: "notYourCharacter" };
  const choice = spellId === null ? undefined : pending.options.find((option) => option.spellId === spellId);
  if (spellId !== null && choice === undefined) return { code: "unknownSpell" };

  decision.request({ kind: "cancelTimer", timerId: reactionTimerId(resolution.id, pending.rollId) });
  decision.emit({ kind: "reactionAnswered", resolutionId: resolution.id, targetId: combatantId, spellId, slotLevel: choice?.slotLevel ?? null });
  if (choice !== undefined) {
    const spell = decision.ctx.rules.content.get(choice.spellId);
    if (spell.kind === "spell" && spell.reaction?.kind === "acBonusUntilNextTurn") {
      // Until the start of its own next turn: this round if that turn is still to come, otherwise the next.
      const untilRound = encounter.order.indexOf(combatantId) > encounter.turnIndex ? encounter.round : encounter.round + 1;
      decision.emit({
        kind: "effectApplied",
        combatantId,
        effect: {
          id: `${resolution.id}:${combatantId}:${spell.id}`,
          definition: spell.id,
          sourceId: combatantId,
          conditions: [],
          modifiers: [{ kind: "acBonus", amount: spell.reaction.bonus }],
          triggers: [],
          clock: { follows: "target", boundary: "start", untilRound },
          concentrationId: null,
          stacking: "coexist",
        },
      });
    }
    decision.request({ kind: "deliver", delivery: { kind: "combatBeat", encounterId: encounter.id, combatantId, beat: "reaction" } });
  }
  return settleCheck(decision, resolution.id, pending.rollId, pending.roll);
}

// A window ran out of time: the target declines.
export function reactionTimerExpired(decision: Decision, encounterId: string, resolutionId: string): Rejection | null {
  if (decision.ctx.actor.kind !== "system") return { code: "systemOnly" };
  const encounter = activeEncounter(decision);
  const pending = encounter?.resolution?.reaction;
  if (encounter?.id !== encounterId || encounter.resolution?.id !== resolutionId || pending == null || decision.state.status !== "active") return null;
  return answerReaction(decision, pending.targetId, null, "system");
}

// The target went away with a window open: it declines.
export function declineReactionFor(decision: Decision, combatantId: string): void {
  const pending = activeEncounter(decision)?.resolution?.reaction;
  if (pending?.targetId === combatantId) answerReaction(decision, combatantId, null, "system");
}
