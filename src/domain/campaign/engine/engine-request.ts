import type { CheckId, Instant, RollId, TimerId } from "../core/ids.js";
import type { D20TestSpec } from "../dice/d20-test.js";

// Work the engine needs the application to do, expressed as data and saved
// to the outbox in the same transaction as the events.
export type EngineRequest =
  // Roll this spec once and re-enter with recordRoll; a retry reuses the saved roll.
  | { readonly kind: "roll"; readonly rollId: RollId; readonly spec: D20TestSpec }
  | { readonly kind: "plan"; readonly roundNumber: number }
  | { readonly kind: "narrate"; readonly roundNumber: number }
  | { readonly kind: "startTimer"; readonly timer: TimerSpec }
  | { readonly kind: "cancelTimer"; readonly timerId: TimerId }
  | { readonly kind: "deliver"; readonly delivery: DeliverySpec };

export type TimerSpec =
  | { readonly kind: "roundWindow"; readonly timerId: TimerId; readonly dueAt: Instant; readonly roundNumber: number }
  | { readonly kind: "roll"; readonly timerId: TimerId; readonly dueAt: Instant; readonly checkId: CheckId };

export type DeliverySpec =
  // The "?" die appears (panel spec: Dice moments).
  | { readonly kind: "rollStarted"; readonly checkId: CheckId }
  // The staged reveal lands on the saved result.
  | { readonly kind: "rollResult"; readonly checkId: CheckId }
  // Everyone passed or missed: a template waiting status, no model call.
  | { readonly kind: "quietRound"; readonly roundNumber: number }
  | { readonly kind: "waitingForPlayers" };
