import type { D20TestRoll } from "../../dice/d20-test.js";
import { availableSlots, isPresent, type PendingReaction, type Combatant, type EncounterState, type ResolutionState } from "../../combat/combat-state.js";
import { distanceBetween } from "../../combat/positioning.js";
import type { ReactionRule } from "../../rules/content-definitions.js";
import { canReact, conditionLookup } from "../../effects/effect-queries.js";
import { castableSlotLevels } from "../../magic/spell-rules.js";
import type { ContentId } from "../../rules/content-id.js";
import type { SealedContent } from "../../rules/content-registry.js";
import { deadlineAfter, type Decision } from "../decision.js";
import type { Rejection } from "../rejection.js";
import { activeEncounter, afterResolution, isPlayerControlled, mayActFor } from "./combat-flow.js";
import { declareResolution, finishResolution, landEffects, settleCheck, startResolution } from "./resolution.js";

// Reactions (SRD 5.1: Shield). When an attack roll hits a creature that could
// turn the hit into a miss, the hit is not final yet: a window opens in which its
// player may cast the reaction spell or decline. The attack roll stays saved, the
// resolution goes no further until the answer (or the timer, which declines), and
// then the hit is settled again against the armor class the answer produced.

export const reactionTimerId = (resolutionId: string, rollId: string): string => `reaction:${resolutionId}:${rollId}`;

// The reaction spells this creature could cast now, each at the lowest slot that fits.
export function reactionOptions(target: Combatant, content: SealedContent, kind: ReactionRule["kind"] = "acBonusUntilNextTurn", atLeastSlot = 0): PendingReaction["options"] {
  const casting = target.spellcasting;
  if (target.source.kind !== "hero" || casting === null || !canReact(target, conditionLookup(content))) return [];
  return casting.spells.flatMap((id) => {
    const spell = content.find(id);
    if (spell?.kind !== "spell" || spell.reaction?.kind !== kind) return [];
    const slotLevel = castableSlotLevels(spell, availableSlots(target.resources)).find((level) => level >= atLeastSlot);
    return slotLevel === undefined ? [] : [{ spellId: spell.id, slotLevel }];
  });
}

function openWindow(decision: Decision, encounter: EncounterState, resolution: ResolutionState, reaction: Omit<PendingReaction, "closesAt">): void {
  const closesAt = deadlineAfter(decision.ctx.now, decision.state.pacing.turnSeconds);
  decision.emit({ kind: "reactionOffered", resolutionId: resolution.id, reaction: { ...reaction, closesAt } });
  decision.request({ kind: "deliver", delivery: { kind: "reactionOffered", encounterId: encounter.id, attackId: resolution.id } });
  if (closesAt !== null) {
    decision.request({ kind: "startTimer", timer: { kind: "combatReaction", timerId: reactionTimerId(resolution.id, reaction.rollId), dueAt: closesAt, encounterId: encounter.id, resolutionId: resolution.id } });
  }
}

// A foe is casting a spell: a hero who can counter it (a slot of the spell's level or higher, and at least the 3rd)
// gets to say so before anything is rolled. True when a window opened (the caller stops).
export function offerCounterspell(decision: Decision, encounter: EncounterState, resolution: ResolutionState): boolean {
  if (resolution.source.kind !== "spell" || resolution.purpose === "reaction" || resolution.source.metamagic === "subtle") return false;
  const caster = encounter.combatants[resolution.actorId];
  if (caster === undefined || caster.side !== "foes") return false;
  const content = decision.ctx.rules.content;
  const cast = content.find(resolution.source.spellId);
  if (cast?.kind !== "spell") return false;
  for (const hero of Object.values(encounter.combatants)) {
    if (hero.side !== "party" || !isPlayerControlled(decision, hero) || !isPresent(hero) || hero.hp <= 0) continue;
    const options = reactionOptions(hero, content, "counterspell", Math.max(3, cast.level));
    if (options.length === 0) continue;
    openWindow(decision, encounter, resolution, { rollId: "counter", targetId: hero.id, roll: null, trigger: "spell", spellId: cast.id, options });
    return true;
  }
  return false;
}

// A foe's action has just damaged a hero who could answer with a spell of their own (Hellish Rebuke, within 60
// feet). True when a window opened (the caller stops).
export function offerRetort(decision: Decision, encounter: EncounterState, resolution: ResolutionState): boolean {
  const attacker = encounter.combatants[resolution.actorId];
  if (attacker === undefined || attacker.side !== "foes" || !isPresent(attacker) || attacker.hp <= 0 || resolution.purpose === "reaction") return false;
  const content = decision.ctx.rules.content;
  for (const targetId of resolution.targetIds) {
    const target = encounter.combatants[targetId];
    const outcome = resolution.outcomes[targetId];
    if (target === undefined || target.side !== "party" || !isPlayerControlled(decision, target) || !isPresent(target) || target.hp <= 0) continue;
    const label = `retort:${targetId}`;
    if ((resolution.reactionsAsked ?? []).includes(label)) continue;
    const effects = outcome?.landed === true ? landEffects(resolution, encounter) : resolution.plan.onAvoid;
    if (!effects.some((effect) => effect.kind === "damage" && effect.target === "target")) continue;
    const options = reactionOptions(target, content, "retort").filter(() => (distanceBetween(encounter, target.id, attacker.id) ?? Infinity) <= 60);
    if (options.length === 0) continue;
    openWindow(decision, encounter, resolution, { rollId: label, targetId, roll: null, trigger: "damage", options });
    return true;
  }
  return false;
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
  openWindow(decision, encounter, resolution, { rollId, targetId: target.id, roll, options });
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
  const trigger = pending.trigger ?? "hit";

  decision.request({ kind: "cancelTimer", timerId: reactionTimerId(resolution.id, pending.rollId) });
  decision.emit({ kind: "reactionAnswered", resolutionId: resolution.id, targetId: combatantId, spellId, slotLevel: choice?.slotLevel ?? null });
  if (trigger === "spell") return answerCounterspell(decision, resolution.id, choice !== undefined, combatantId);
  if (trigger === "damage") return answerRetort(decision, resolution, combatantId, choice);
  if (pending.roll === null) return { code: "noReaction" };
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

// The counterspell answer: countered, the spell does nothing; declined, its rolls are asked for as they would have been.
function answerCounterspell(decision: Decision, resolutionId: string, countered: boolean, combatantId: string): Rejection | null {
  if (!countered) {
    startResolution(decision);
    return null;
  }
  decision.emit({ kind: "spellCountered", resolutionId });
  const encounter = activeEncounter(decision);
  if (encounter !== null) decision.request({ kind: "deliver", delivery: { kind: "combatBeat", encounterId: encounter.id, combatantId, beat: "counterspell" } });
  finishResolution(decision);
  return null;
}

// The retort answer: declined, the action just finishes; cast, the action ends and the retort is resolved as its own
// (the spell's saving throw and damage), after which play carries on as it would have.
function answerRetort(decision: Decision, resolution: ResolutionState, combatantId: string, choice: PendingReaction["options"][number] | undefined): Rejection | null {
  if (choice === undefined) {
    finishResolution(decision);
    return null;
  }
  const encounter = activeEncounter(decision);
  const caster = encounter?.combatants[combatantId];
  if (encounter === null || caster === undefined) {
    finishResolution(decision);
    return null;
  }
  decision.emit({ kind: "resolutionFinished", resolutionId: resolution.id });
  decision.request({ kind: "deliver", delivery: { kind: "attackResolved", encounterId: encounter.id, attackId: resolution.id } });
  const rejected = declareResolution(decision, {
    actor: caster,
    source: { kind: "spell", spellId: choice.spellId, slotLevel: choice.slotLevel },
    targetIds: [resolution.actorId],
    purpose: "reaction",
    cost: { action: false, bonusAction: false, reaction: false, spellSlot: null, featureUse: null },
    resumes: resolution,
  });
  if (rejected !== null) afterResolution(decision, resolution);
  return null;
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
