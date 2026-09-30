import type { Clock } from "../ports/clock.js";

// A clock that only moves when told to: the harness and tests use it to
// make timers fire deterministically.
export class ManualClock implements Clock {
  public constructor(private current = 0) {}

  public now(): number {
    return this.current;
  }

  public advance(milliseconds: number): void {
    this.current += milliseconds;
  }
}
