import type { CharacterId } from "../core/ids.js";
import type { ContentId } from "../rules/content-id.js";

// Creatures a hero brought along between fights: a familiar that stays until it
// is dismissed or killed, or the beasts and spirits of a minute-long conjuring
// that last through the next fight. Only what the campaign has to remember is
// kept here (who, which stat block, how hurt); the stat block itself is read
// from the content register when a fight begins, so nothing is copied.
export interface Companion {
  readonly id: string;
  readonly ownerId: CharacterId;
  readonly monsterId: ContentId<"monster">;
  readonly spellId: ContentId<"spell">;
  // Hit points it carries into the next fight; null is a full set.
  readonly hp: number | null;
  readonly lasts: "nextFight" | "dismissed";
}

export interface CompanionRoster {
  readonly members: Readonly<Record<string, Companion>>;
  // Numbers companion IDs deterministically.
  readonly count: number;
}

// What the roster needs to know of a creature in a fight: structural, so it does not depend on the combat model.
export interface FightSurvivor {
  readonly companionId?: string;
  readonly hp: number;
  readonly condition: string;
}

export const emptyRoster: CompanionRoster = { members: {}, count: 0 };

export function companionsOf(roster: CompanionRoster | undefined, ownerId: CharacterId): readonly Companion[] {
  return Object.values(roster?.members ?? {}).filter((companion) => companion.ownerId === ownerId);
}

// Adds new companions, first dropping the ones they replace.
export function withSummoned(roster: CompanionRoster | undefined, added: readonly Companion[], replaced: readonly string[]): CompanionRoster {
  const current = roster ?? emptyRoster;
  const members = Object.fromEntries(Object.entries(current.members).filter(([id]) => !replaced.includes(id)));
  for (const companion of added) members[companion.id] = companion;
  return { members, count: current.count + added.length };
}

export function withoutCompanions(roster: CompanionRoster | undefined, ids: readonly string[]): CompanionRoster | undefined {
  if (roster === undefined) return roster;
  return { ...roster, members: Object.fromEntries(Object.entries(roster.members).filter(([id]) => !ids.includes(id))) };
}

// A fight is over: the companions that fell are gone, a conjuring's creatures have run their minute,
// and the rest carry their wounds forward.
export function afterFight(roster: CompanionRoster | undefined, creatures: readonly FightSurvivor[]): CompanionRoster | undefined {
  if (roster === undefined) return roster;
  const members: Record<string, Companion> = {};
  for (const companion of Object.values(roster.members)) {
    const creature = creatures.find((candidate) => candidate.companionId === companion.id);
    // A companion that took no part (its owner was down) is left as it was.
    if (creature === undefined) {
      members[companion.id] = companion;
      continue;
    }
    if (companion.lasts === "nextFight" || creature.condition === "dead" || creature.hp <= 0) continue;
    members[companion.id] = { ...companion, hp: creature.hp };
  }
  return { ...roster, members };
}

// A long rest heals what stays and ends every conjuring whose minute is long past.
export function afterRest(roster: CompanionRoster | undefined, rest: "short" | "long"): CompanionRoster | undefined {
  if (roster === undefined || rest === "short") return roster;
  const members: Record<string, Companion> = {};
  for (const companion of Object.values(roster.members)) {
    if (companion.lasts === "dismissed") members[companion.id] = { ...companion, hp: null };
  }
  return { ...roster, members };
}
