import { deriveSnapshotSheet } from "../../../domain/campaign/character/leveling.js";
import type { CharacterSheet } from "../../../domain/campaign/character/character-sheet.js";
import { importedGear, resolveHouseRules } from "../../../domain/campaign/rules/house-rules.js";
import type { LibrarySnapshot } from "./library-types.js";

// The hero a campaign gets from a snapshot: a fresh copy with its own ID, all
// numbers derived from the build, full HP and slots as any new hero has, and
// the snapshot it came from written on it. Nothing here points back at live
// state, so no campaign can change another's copy or the library's snapshot.
// A table that plays "starter" gear ignores what the character earned.
export function instantiateHero(snapshot: LibrarySnapshot, houseRules: Readonly<Record<string, string>>): Omit<CharacterSheet, "ownerUserId"> {
  const starter = resolveHouseRules(houseRules).option(importedGear) === "starter";
  const derived = deriveSnapshotSheet(snapshot.build, starter ? undefined : snapshot.gear, snapshot.progression);
  return {
    ...derived,
    id: heroIdFor(snapshot.id),
    origin: { libraryCharacterId: snapshot.characterId, snapshotId: snapshot.id },
  };
}

// "ls-abc123def456" plays as "c-abc123def456", the shape of every hero ID.
export function heroIdFor(snapshotId: string): string {
  return `c-${snapshotId.replace(/^ls-/, "")}`;
}
