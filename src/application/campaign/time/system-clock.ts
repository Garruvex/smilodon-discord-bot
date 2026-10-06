import type { Clock } from "../ports/clock.js";

export class SystemClock implements Clock {
  public now(): number {
    return Date.now();
  }
}
