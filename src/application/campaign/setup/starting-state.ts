import { raiseToLevel } from "../../../domain/campaign/character/leveling.js";
import type { CharacterSheet } from "../../../domain/campaign/character/character-sheet.js";
import type { CampaignId, UserId } from "../../../domain/campaign/core/ids.js";
import type { CampaignState, MemberState, Pacing } from "../../../domain/campaign/state/campaign-state.js";
import type { AdventureDocument, PresetHero } from "../adventures/adventure-document.js";

// A player and the preset hero they play.
export interface Seat {
  readonly userId: UserId;
  readonly heroId: string;
  // A hero brought from the character library, already derived and checked:
  // used instead of a preset of the adventure.
  readonly sheet?: Omit<CharacterSheet, "ownerUserId">;
}

export class StartingStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StartingStateError";
  }
}

// The engine state a campaign begins with: each seat's preset hero copied into
// the campaign (so later changes to the adventure never touch a running game),
// the party in seat order, and the adventure's first scene.
export function buildStartingState(input: {
  readonly campaignId: CampaignId;
  readonly organizerId: UserId;
  readonly adventure: AdventureDocument;
  readonly seats: readonly Seat[];
  readonly pacing: Pacing;
  // Every hero below this level is brought up to it before play begins.
  readonly startingLevel?: number;
}): CampaignState {
  const { adventure, seats } = input;
  if (seats.length === 0) throw new StartingStateError("A campaign needs at least one player.");
  const members: Record<UserId, MemberState> = {};
  const characters: Record<string, CharacterSheet> = {};
  for (const seat of seats) {
    const hero = seat.sheet ?? adventure.heroes.find((candidate) => candidate.id === seat.heroId);
    if (hero === undefined) throw new StartingStateError(`The adventure has no hero ${seat.heroId}.`);
    if (characters[hero.id] !== undefined) throw new StartingStateError(`Hero ${hero.id} is chosen twice.`);
    if (members[seat.userId] !== undefined) throw new StartingStateError(`Player ${seat.userId} has two seats.`);
    let owned: CharacterSheet;
    if (seat.sheet !== undefined) owned = { ...seat.sheet, ownerUserId: seat.userId };
    else {
      const { class: className, ...sheet } = hero as PresetHero;
      owned = { ...sheet, className, ownerUserId: seat.userId };
    }
    characters[hero.id] = raiseToLevel(owned, input.startingLevel ?? 1);
    members[seat.userId] = { userId: seat.userId, characterId: hero.id, availability: "present", consecutiveMisses: 0 };
  }
  return {
    campaignId: input.campaignId,
    organizerId: input.organizerId,
    status: "active",
    language: adventure.bible.language,
    pacing: input.pacing,
    sceneId: adventure.bible.startScene,
    ...(adventure.bible.startTime === undefined ? {} : { world: { day: adventure.bible.startTime.day ?? 1, time: adventure.bible.startTime.time, ...(adventure.bible.startTime.weather === undefined ? {} : { weather: adventure.bible.startTime.weather }) } }),
    members,
    characters,
    round: null,
    lastRoundNumber: 0,
    lastNarratedRound: 0,
    checks: {},
    ledger: {},
    encounter: null,
    heroStatus: {},
    pendingEncounter: null,
    encounterHistory: [],
    stash: [],
    gold: 0,
    offers: {},
    offerCount: 0,
    trades: {},
    tradeCount: 0,
    dialogues: {},
    dialogueCount: 0,
    utilityCasts: {},
    utilityCastCount: 0,
    hazards: {},
    hazardCount: 0,
    healingCount: 0,
    fightCheckpoint: null,
    pausedBy: null,
    clocks: {},
    clues: [],
  };
}
