import type { BuildChoices } from "../../../domain/campaign/character/character-build.js";
import type { Instant, UserId } from "../../../domain/campaign/core/ids.js";
import type { ContentId } from "../../../domain/campaign/rules/content-id.js";

// The Discord-owned character library (plan §3). A character belongs to a
// Discord user, across servers. It is a chain of immutable snapshots: the
// build's choices, the gear it carries, and where it came from. A campaign
// hero is a copy made from one snapshot and never shares live state with it
// or with any other campaign.

export interface LibraryCharacter {
  readonly id: string;
  readonly ownerUserId: UserId;
  readonly name: string;
  readonly className: string;
  readonly createdAt: Instant;
}

// Where a snapshot came from: the builder, a campaign's Save Progress, or an
// imported file.
export type SnapshotSource =
  | { readonly kind: "builder" }
  | { readonly kind: "import" }
  | { readonly kind: "campaign"; readonly campaignId: string; readonly heroId: string; readonly stateRevision: number };

export interface SnapshotGear {
  // What the character carries out of a campaign, worn armor and shield included.
  readonly equipment: readonly ContentId<"item">[];
  readonly worn?: readonly ContentId<"item">[];
}

export interface LibrarySnapshot {
  readonly id: string;
  readonly characterId: string;
  readonly ownerUserId: UserId;
  // 1 for the first snapshot of the character, then 2, 3...
  readonly revision: number;
  // "main" for the builder's own line; a campaign ID for a line of progress
  // saved from that campaign. Parallel campaigns make parallel branches, and
  // nothing merges them.
  readonly branch: string;
  readonly parentSnapshotId: string | null;
  readonly source: SnapshotSource;
  // One snapshot per (character, source key): saving the same state twice
  // finds the first instead of making another.
  readonly sourceKey: string;
  readonly rulesetId: string;
  readonly rulesetVersion: string;
  readonly createdAt: Instant;
  // The player's choices: every number is derived from them, never stored.
  readonly build: BuildChoices;
  readonly gear: SnapshotGear;
}

// A lobby seat that holds a saved character names its snapshot: "lib:<snapshot id>".
export const libraryHeroPrefix = "lib:";
export const libraryHeroRef = (snapshotId: string): string => `${libraryHeroPrefix}${snapshotId}`;
export function savedSnapshotIdOf(heroRef: string | null): string | null {
  return heroRef?.startsWith(libraryHeroPrefix) === true ? heroRef.slice(libraryHeroPrefix.length) : null;
}

// The file a player can export and import. The sheet is not in it: the
// importer derives every number again from the build.
export interface PortableCharacter {
  readonly format: "dnd-character";
  readonly version: 1;
  readonly rulesetId: string;
  readonly rulesetVersion: string;
  readonly build: BuildChoices;
  readonly gear: SnapshotGear;
}
