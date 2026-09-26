// Identifiers are plain strings at runtime. The aliases document intent at
// every signature; IDs the engine creates itself are derived deterministically
// (see engine/ids.ts), so the domain needs no ID generator.
export type CampaignId = string;
export type UserId = string;
export type CharacterId = string;
export type CheckId = string;
export type RollId = string;
export type TimerId = string;

// Milliseconds since the Unix epoch, always supplied by the application's
// Clock port; the domain never reads the clock.
export type Instant = number;
