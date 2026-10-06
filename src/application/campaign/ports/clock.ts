import type { Instant } from "../../../domain/campaign/core/ids.js";

export interface Clock {
  now(): Instant;
}
