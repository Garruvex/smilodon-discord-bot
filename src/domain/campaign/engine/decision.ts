import type { Actor, PartyEffect } from "../commands/campaign-command.js";
import type { Instant } from "../core/ids.js";
import type { CampaignEvent } from "../events/campaign-event.js";
import { evolve } from "../events/evolve.js";
import type { SealedRuleset } from "../rules/ruleset.js";
import { isFallen, type CampaignState } from "../state/campaign-state.js";
import { changedWorld, isTimeOfDay, isWeather, maxDay, timesOfDay, weathers, type WorldChange } from "../state/world-state.js";
import type { EngineRequest, PictureSnapshot } from "./engine-request.js";
import type { Rejection } from "./rejection.js";
import { applyStoryEffect } from "./story-effects.js";

export interface EngineContext {
  readonly rules: SealedRuleset;
  // Supplied by the application from the Clock port.
  readonly now: Instant;
  readonly actor: Actor;
}

export type DecideResult =
  | {
      readonly kind: "accepted";
      readonly events: readonly CampaignEvent[];
      readonly requests: readonly EngineRequest[];
    }
  | { readonly kind: "rejected"; readonly rejection: Rejection };

// Accumulates the events and requests of one decision. Each emitted event is
// applied immediately, so later steps of the same decision (closing a round
// after the last submission) see the state the earlier steps produced.
export class Decision {
  private readonly emitted: CampaignEvent[] = [];
  private readonly requested: EngineRequest[] = [];
  private turnStarts = 0;

  public constructor(
    private current: CampaignState,
    public readonly ctx: EngineContext,
  ) {}

  public get state(): CampaignState {
    return this.current;
  }

  public emit(event: CampaignEvent): void {
    this.emitted.push(event);
    this.current = evolve(this.current, event);
  }

  // Applies one story effect (a round's planned effect, or a fight's trigger or victory): the engine's single story vocabulary.
  public applyStory(roundNumber: number, effect: PartyEffect): void {
    applyStoryEffect(this, roundNumber, effect);
  }

  // The story's clock or sky moves (or does not, when the adventure keeps none or the change changes nothing). Returns whether it moved.
  public changeWorld(roundNumber: number, change: WorldChange, reason: "story" | "rest" | "correction", note?: string): boolean {
    // A correction may start a clock the adventure did not have; nothing else does.
    const world = this.current.world ?? (reason === "correction" ? ({ day: 1, time: "morning" } as const) : undefined);
    if (world === undefined) return false;
    const next = changedWorld(world, change);
    if (next === null && this.current.world !== undefined) return false;
    this.emit({ kind: "worldChanged", roundNumber, world: next ?? world, reason, ...(note === undefined || note.trim() === "" ? {} : { note: note.trim().slice(0, 200) }) });
    return true;
  }

  // Why a change to the world is not allowed, or null when it is: a day outside 1 to 10000, a time or weather that does not exist.
  public worldProblem(change: WorldChange): string | null {
    if (change.kind === "advance") return Number.isInteger(change.steps) && change.steps >= 1 && change.steps <= 12 ? null : `Time may pass by 1 to 12 phases of the day, not ${change.steps}.`;
    if (change.kind === "weather") return change.weather === null || isWeather(change.weather) ? null : `Weather "${String(change.weather)}" is not one of ${weathers.join(", ")}.`;
    if (change.kind === "rest") return null;
    if (change.day !== undefined && (!Number.isInteger(change.day) || change.day < 1 || change.day > maxDay)) return `Day ${change.day} is out of range.`;
    if (change.time !== undefined && !isTimeOfDay(change.time)) return `Time "${String(change.time)}" is not one of ${timesOfDay.join(", ")}.`;
    if (change.weather !== undefined && change.weather !== null && !isWeather(change.weather)) return `Weather "${String(change.weather)}" is not one of ${weathers.join(", ")}.`;
    return null;
  }

  // The scene, time and present heroes as they are now, for a picture that will be painted later.
  public pictureSnapshot(): PictureSnapshot {
    const state = this.current;
    const heroes = Object.values(state.members).flatMap((member) => {
      const sheet = member.availability === "present" && member.characterId !== null ? state.characters[member.characterId] : undefined;
      return sheet === undefined || isFallen(state, sheet.id) ? [] : [{ id: sheet.id, level: sheet.level, equipment: [...sheet.equipment] }];
    });
    return { sceneId: state.sceneId, ...(state.world === undefined ? {} : { world: state.world }), heroes };
  }

  public request(request: EngineRequest): void {
    this.requested.push(request);
  }

  // Combat turns started in this decision; the engine uses it to stop a
  // runaway chain of engine-played turns.
  public countTurnStart(): number {
    this.turnStarts += 1;
    return this.turnStarts;
  }

  public result(): DecideResult {
    return { kind: "accepted", events: [...this.emitted], requests: [...this.requested] };
  }
}

// Seconds from the pacing settings to an absolute deadline, or null for "no timer".
export function deadlineAfter(now: Instant, seconds: number | null): Instant | null {
  return seconds === null ? null : now + seconds * 1000;
}
