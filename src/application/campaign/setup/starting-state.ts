import type { CharacterSheet } from "../../../domain/campaign/character/character-sheet.js";
import type { CampaignId, UserId } from "../../../domain/campaign/core/ids.js";
import type { CampaignState, MemberState, Pacing } from "../../../domain/campaign/state/campaign-state.js";
import type { AdventureDocument } from "../adventures/adventure-document.js";

// A player and the preset hero they play.
export interface Seat {
  readonly userId: UserId;
  readonly heroId: string;
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
}): CampaignState {
  const { adventure, seats } = input;
  if (seats.length === 0) throw new StartingStateError("A campaign needs at least one player.");
  const members: Record<UserId, MemberState> = {};
  const characters: Record<string, CharacterSheet> = {};
  for (const seat of seats) {
    const hero = adventure.heroes.find((candidate) => candidate.id === seat.heroId);
    if (hero === undefined) throw new StartingStateError(`The adventure has no hero ${seat.heroId}.`);
    if (characters[hero.id] !== undefined) throw new StartingStateError(`Hero ${hero.id} is chosen twice.`);
    if (members[seat.userId] !== undefined) throw new StartingStateError(`Player ${seat.userId} has two seats.`);
    const { class: className, ...sheet } = hero;
    characters[hero.id] = { ...sheet, className, ownerUserId: seat.userId };
    members[seat.userId] = { userId: seat.userId, characterId: hero.id, availability: "present", consecutiveMisses: 0 };
  }
  return {
    campaignId: input.campaignId,
    organizerId: input.organizerId,
    status: "active",
    language: adventure.bible.language,
    pacing: input.pacing,
    sceneId: adventure.bible.startScene,
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
    fightCheckpoint: null,
    pausedBy: null,
    clocks: {},
    clues: [],
  };
}
