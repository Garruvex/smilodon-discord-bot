import type { Actor } from "../commands/campaign-command.js";
import type { Instant } from "../core/ids.js";
import type { CampaignEvent } from "../events/campaign-event.js";
import { evolve } from "../events/evolve.js";
import type { SealedRuleset } from "../rules/ruleset.js";
import type { CampaignState } from "../state/campaign-state.js";
import type { EngineRequest } from "./engine-request.js";
import type { Rejection } from "./rejection.js";

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

  public request(request: EngineRequest): void {
    this.requested.push(request);
  }

  public result(): DecideResult {
    return { kind: "accepted", events: [...this.emitted], requests: [...this.requested] };
  }
}

// Seconds from the pacing settings to an absolute deadline, or null for "no timer".
export function deadlineAfter(now: Instant, seconds: number | null): Instant | null {
  return seconds === null ? null : now + seconds * 1000;
}
