import type { AdventureBible } from "../../domain/campaign/adventure/adventure-bible.js";
import type { UserId } from "../../domain/campaign/core/ids.js";
import { maxLevel } from "../../domain/campaign/character/leveling.js";
import { timesOfDay, weathers } from "../../domain/campaign/rules/world-rules.js";
import { actingHero } from "../../domain/campaign/engine/members.js";
import { isFallen, presentMembers, type CampaignState } from "../../domain/campaign/state/campaign-state.js";
import { hitDicePool } from "../../domain/campaign/character/character-build.js";
import type { SealedContent, Glossary } from "../../domain/campaign/rules/content-registry.js";
import type { CheckTest } from "../../domain/campaign/character/character-sheet.js";
import { findScene } from "../../domain/campaign/adventure/adventure-bible.js";
import { levelingMode, resolveHouseRules } from "../../domain/campaign/rules/house-rules.js";
import type { CombatView, DeathSavesView } from "./views/campaign-views.js";
import { companionsOf } from "../../domain/campaign/companions/companion-roster.js";
import { buildPanelView, buildPartyView, buildHeroView, buildReactionView, buildSmiteView, buildOpportunityAttackView } from "./views/campaign-views.js";
import { buildExploreView, buildShopView, type ExploreView, type ShopView } from "./views/explore-view.js";
import { buildTurnView, type AttackChoice, type SpellChoice, type TurnView } from "./views/turn-view.js";
import type { CampaignRecord } from "./ports/campaign-record.js";
import { readyToStart } from "../../domain/campaign/lobby/lobby.js";
import { texts } from "../i18n/texts.js";
import { buildMapView } from "./views/map-view.js";
import { spellFactsByName, type SpellFacts } from "./views/spell-facts.js";
import { buildHeroSheetView, buildLevelUpView, type HeroSheetView, type LevelUpView } from "./views/hero-sheet.js";
import { buildHouseRulesView, type HouseRulesView } from "./views/house-rules-view.js";
import { buildJournal, buildPlaces, buildRecap, type JournalView, type PlaceView, type RecapView } from "./views/story-views.js";
import { buildActivityStory, type StoryEntry } from "./views/activity-story.js";
import type { CampaignEvent } from "../../domain/campaign/events/campaign-event.js";

// A picture is on disk once it is made, even while its Discord post is still being retried.
const hasPicture = (status: string | undefined): boolean => status === "done" || status === "made";

export interface ActivityTableView {
  readonly kind: "table";
  readonly language: CampaignRecord["language"];
  // Class names in the game's language, keyed by the class id.
  readonly classNames: Readonly<Record<string, string>>;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly adventureTitle: string;
  readonly sceneId: string | null;
  readonly mode: string;
  readonly ownPresence: "present" | "away";
  readonly canTogglePresence: boolean;
  readonly roundNumber: number | null;
  // What the table may read back: the story so far, where the party has been, who and what it knows. The same words the Discord journal and recap use.
  readonly journal: { readonly journal: JournalView; readonly places: readonly PlaceView[]; readonly recap: RecapView };
  // The story's day, time of day and weather, when the adventure keeps a clock.
  readonly world: null | { readonly day: number; readonly time: string; readonly weather: string | null };
  // fallbackImageUrl: the scene's own picture, when imageUrl is a fight's picture that may not be there yet.
  readonly scene: { readonly title: string; readonly description: string; readonly imageUrl: string | null; readonly fallbackImageUrl?: string | null };
  // present and needed: how many players vote, and how many Stay votes keep the party where it is. closesAt: when the window closes (epoch ms), or null.
  readonly pendingMove: null | { readonly sceneId: string; readonly sceneTitle: string; readonly sceneDescription: string; readonly proposedBy: string | null; readonly supporters: readonly string[]; readonly staying: readonly string[]; readonly choiceByYou: "go" | "stay" | null; readonly present: number; readonly needed: number; readonly closesAt: number | null };
  readonly canVoteMove: boolean;
  readonly map:
    | { readonly kind: "battlefield"; readonly zones: readonly { readonly id: string; readonly name: string; readonly lighting: string | null; readonly cover: string | null; readonly difficult: boolean; readonly canMove: boolean; readonly occupants: readonly { readonly name: string; readonly side: "party" | "foes"; readonly rank?: "boss" | "elite" | "minion" | "standard"; readonly active: boolean; readonly hp: number; readonly maxHp: number }[] }[]; readonly edges: readonly { readonly from: string; readonly to: string; readonly feet: number }[] }
    | { readonly kind: "journey"; readonly nodes: readonly { readonly id: string; readonly title: string; readonly status: "current" | "visited" | "known" | "reachable" | "locked"; readonly locked: boolean; readonly deadEnd: boolean; readonly canTravel: boolean; readonly column: number; readonly row: number }[]; readonly routes: readonly { readonly from: string; readonly to: string; readonly oneWay: boolean }[] };
  // Every word of the map, in the game's language.
  readonly mapText: Readonly<Record<"journeyKind" | "journeyTitle" | "tacticalKind" | "battlefield" | "keyParty" | "keyFoes" | "keyHere" | "keyOpen" | "keyLocked" | "empty" | "routeLabel" | "here" | "deadEnd" | "locked" | "visited" | "mapped" | "openRoute" | "openGround" | "difficult" | "coverHalf" | "coverThreeQuarters" | "lightBright" | "lightDim" | "lightDark" | "moveHere", string>>;
  // Your Hit Dice: how many are left, the size of the next one, and whether they can be spent now (after a short rest, before the next round or fight).
  readonly hitDice: { readonly left: number; readonly die: number | null; readonly canSpend: boolean; readonly rolling: boolean } | null;
  readonly yourTurn: boolean;
  readonly canBegin: boolean;
  // Stopping and resting: any player may stop play, the organizer may pause and ask for a rest.
  readonly controls: {
    readonly canStop: boolean;
    readonly canPause: boolean;
    // The organizer can open a finished game again.
    readonly canReopen: boolean;
    // The organizer's way to run the game: which verbs make sense right now, the party's level, and the story clock. Null for everyone else.
    readonly run: null | {
      readonly closeRound: boolean;
      readonly retry: boolean;
      readonly retryFight: boolean;
      readonly retell: boolean;
      readonly illustrate: boolean;
      readonly illustrateScene: boolean;
      readonly lowestLevel: number;
      readonly maxLevel: number;
      readonly world: null | { readonly day: number; readonly time: string; readonly weather: string | null };
      readonly times: readonly string[];
      readonly weathers: readonly string[];
    };
    // Who may play your hero while you are away: the other players with a hero, and who it is now. Null without a hero of your own.
    readonly proxy: null | { readonly current: string | null; readonly options: readonly { readonly userId: string; readonly heroName: string }[] };
    // A player present may propose a rest to the table.
    readonly canPropose: boolean;
    readonly rest: null | { readonly askedFor: "short" | "long" | null; readonly resting: "short" | "long" | null; readonly now: boolean };
  };
  // A player's proposal to rest that is open now, with where the vote stands. Null when none is.
  readonly restVote: null | { readonly rest: "short" | "long"; readonly proposedBy: string; readonly agree: number; readonly decline: number; readonly needed: number; readonly present: number; readonly yourAnswer: "agree" | "decline" | null; readonly canAnswer: boolean; readonly closesAt: number };
  // Your hero's companions between fights, and whether they can be sent away now (not during a fight).
  readonly companions: readonly { readonly id: string; readonly name: string; readonly spellName: string; readonly hp: number | null }[];
  readonly canDismissCompanion: boolean;
  // Your hero came from your library and no fight or roll is open, so its progress can be saved for your next game.
  readonly canSaveProgress: boolean;
  readonly canRequestJoin: boolean;
  readonly joinEntrance: string | null;
  readonly activeName: string | null;
  readonly upcomingNames: readonly string[];
  // Everyone in the fight in turn order, starting with whoever is up. Empty outside a fight.
  readonly order: NonNullable<NonNullable<ActivityPanelCombat>["order"]>;
  // How many heroes the table was opened for, so the party panel can show the seats still open.
  readonly partySeats: number;
  readonly party: readonly {
    readonly characterId: string;
    readonly name: string;
    readonly className: string | null;
    readonly raceName: string | null;
    readonly level: number;
    readonly hp: number;
    readonly maxHp: number;
    readonly armorClass: number;
    readonly presence: "present" | "away";
    readonly down: boolean;
    readonly fallen: boolean;
    readonly conditions: readonly string[];
    readonly imageUrl: string | null;
    readonly isYou: boolean;
    // Only for the organizer, on an away player's hero: whose seat the "free seat" button releases.
    readonly seatUserId?: string;
    // Where the hero stands in a fight (the zone's name), otherwise null.
    readonly zone: string | null;
    // While the owner is away: the hero of the player who plays this one for them. Null otherwise.
    readonly playedBy: string | null;
    // Hit Dice left, out of how many, and the size of the next one.
    readonly hitDice: { readonly left: number; readonly max: number; readonly die: number | null };
    // In a fight: the spell they hold their concentration on, their death saves when down, and the conditions and lasting spells on them.
    readonly concentration: string | null;
    readonly deathSaves: DeathSavesView | null;
    readonly statuses: readonly string[];
    // The action they sent for this round, when they have sent one.
    readonly intent: string | null;
    readonly tableStatus: "acting" | "submitted" | "passed" | "missed" | "away" | "waiting";
  }[];
  // When your hero has fallen: the heroes you may take instead. Null otherwise.
  readonly replacement: null | {
    readonly fallenName: string;
    readonly partyLevel: number;
    readonly fightOn: boolean;
    readonly options: readonly { readonly id: string; readonly name: string; readonly className: string }[];
    readonly saved: readonly { readonly id: string; readonly name: string; readonly className: string }[];
  };
  // Your own hero's full sheet, and what you may choose when you level up. Null without a hero.
  readonly heroSheet: HeroSheetView | null;
  readonly levelUp: LevelUpView | null;
  // The rules book's lines for every spell this hero can see, by the name shown on the page.
  readonly spellFacts: Readonly<Record<string, SpellFacts>>;
  // Summons and companions fighting for the party, each with the hero or creature it belongs to.
  readonly allies: readonly { readonly name: string; readonly hp: number; readonly maxHp: number; readonly condition: string; readonly zone: string; readonly active: boolean; readonly ownerName: string | null; readonly concentration: string | null; readonly statuses: readonly string[] }[];
  readonly foes: readonly {
    readonly name: string;
    readonly rank?: "boss" | "elite" | "minion" | "standard";
    readonly hp: number;
    readonly maxHp: number;
    readonly band: string;
    readonly zone: string;
    readonly active: boolean;
    readonly statuses: readonly string[];
  }[];
  readonly offers: readonly { readonly id: string; readonly fromCharacterId: string; readonly toCharacterId: string; readonly fromName: string; readonly toName: string; readonly itemName: string; readonly direction: "incoming" | "outgoing" }[];
  // Full inventory/resource details are disclosed for the requesting player's hero only.
  readonly myHero: null | {
    readonly characterId: string;
    readonly imageUrl: string | null;
    readonly name: string;
    readonly className: string | null;
    readonly raceName: string | null;
    readonly level: number;
    readonly hp: number;
    readonly maxHp: number;
    readonly armorClass: number;
    readonly gold: number;
    readonly partyGold: number;
    readonly weapons: readonly string[];
    readonly worn: readonly string[];
    readonly pack: readonly { readonly id: string; readonly name: string; readonly count: number }[];
    readonly stash: readonly { readonly id: string; readonly name: string; readonly count: number }[];
    readonly inventoryChoices: readonly { readonly id: string; readonly name: string; readonly count: number; readonly wearable: boolean; readonly worn: boolean }[];
    readonly usablePotions: readonly { readonly id: string; readonly name: string; readonly count: number }[];
    readonly cantrips: readonly string[];
    readonly prepared: readonly string[];
    readonly slots: readonly { readonly level: number; readonly left: number; readonly max: number }[];
    readonly pactSlots: readonly { readonly level: number; readonly left: number; readonly max: number }[];
    readonly uses: readonly { readonly id: string; readonly name: string; readonly left: number; readonly max: number }[];
  };
  readonly turn: ActivityTurnView | null;
  readonly explore: (ExploreView & { readonly shops: readonly ShopView[] }) | null;
  readonly pendingRoll: null | { readonly checkId: string; readonly test: CheckTest; readonly action: string | null };
  readonly pendingRollCount: number;
  // The viewer's newest settled rolls (a check, a press); the client shows each one once.
  // The story so far, newest last: what the table has read in the Adventure channel and what the fight did.
  readonly story: readonly StoryEntry[];
  readonly rolls: readonly { readonly id: string; readonly test: CheckTest; readonly natural: number; readonly total: number; readonly dc: number; readonly success: boolean; readonly moment: "natural20" | "natural1" | null }[];
  readonly submittedCount: number;
  readonly participantCount: number;
  readonly submission: "action" | "pass" | "missed" | "excused" | null;
  readonly submissionText: string | null;
  readonly submissionRevision: number | null;
  readonly canAcceptInvite: boolean;
  readonly joinChoices: readonly { readonly id: string; readonly name: string; readonly className: string }[];
  readonly joinRequestStatus: "requested" | "invited" | "approved" | "queued" | null;
  readonly queuedJoin: null | { readonly heroName: string; readonly encounterRound: number | null; readonly nextEncounter: boolean };
  readonly savedHeroChoices: readonly { readonly id: string; readonly name: string; readonly className: string; readonly imageUrl?: string }[];
  readonly reaction: ReturnType<typeof buildReactionView>;
  readonly reactionIsYours: boolean;
  readonly smite: ReturnType<typeof buildSmiteView>;
  readonly smiteIsYours: boolean;
  readonly opportunityAttack: ReturnType<typeof buildOpportunityAttackView>;
  readonly opportunityAttackIsYours: boolean;
}

type ActivityPanelCombat = CombatView | undefined;

// A turn menu with every choice named in the game's language, so the page never has to make a label from a content id.
export type ActivityTurnView = Omit<TurnView, "attacks" | "spells" | "features" | "potions" | "teleports"> & {
  readonly attacks: readonly (AttackChoice & { readonly weaponName: string })[];
  readonly spells: readonly (SpellChoice & { readonly spellName: string })[];
  readonly features: readonly (TurnView["features"][number] & { readonly name: string })[];
  readonly potions: readonly (TurnView["potions"][number] & { readonly name: string })[];
  readonly teleports: readonly (TurnView["teleports"][number] & { readonly spellName: string })[];
  readonly wildShapeChoices: readonly { readonly id: string; readonly name: string }[];
};

export interface ActivityLobbyView {
  readonly kind: "lobby";
  readonly language: CampaignRecord["language"];
  readonly classNames: Readonly<Record<string, string>>;
  readonly campaignId: string;
  readonly campaignName: string;
  readonly adventureTitle: string;
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly canStart: boolean;
  readonly isOrganizer: boolean;
  readonly isMember: boolean;
  readonly canJoin: boolean;
  readonly startBlockReason: "notEnoughPlayers" | "notReady" | null;
  readonly selectedHeroId: string | null;
  readonly selectedHeroName: string | null;
  readonly selectedHeroClass: string | null;
  readonly members: readonly { readonly heroName: string; readonly className: string | null; readonly ready: boolean; readonly isYou: boolean }[];
  readonly heroChoices: readonly { readonly id: string; readonly name: string; readonly className: string; readonly available: boolean }[];
  readonly savedHeroChoices: readonly { readonly id: string; readonly name: string; readonly className: string; readonly imageUrl?: string }[];
  // The table's house rules: everyone can read them, the organizer can change them until the game starts.
  readonly houseRules: HouseRulesView;
}

export type ActivityGameView = ActivityLobbyView | ActivityTableView;

export function buildActivityLobbyView(record: CampaignRecord, bible: AdventureBible, userId: UserId, heroes: readonly { readonly id: string; readonly name: string; readonly class: string }[], savedHeroChoices: readonly { readonly id: string; readonly name: string; readonly className: string; readonly imageUrl?: string }[] = [], now = Date.now()): ActivityLobbyView {
  const ownMember = record.lobby.members.find((member) => member.userId === userId && member.status !== "withdrawn");
  const takenIds = new Set(record.lobby.members.flatMap((member) => member.status !== "withdrawn" && member.heroId !== null && member.userId !== userId ? [member.heroId] : []));
  const selectedPreset = heroes.find((hero) => hero.id === ownMember?.heroId);
  const selectedName = ownMember?.label?.name ?? selectedPreset?.name ?? null;
  const selectedClass = ownMember?.label?.className ?? selectedPreset?.class ?? null;
  const startProblem = readyToStart(record.lobby);
  const members = record.lobby.members.filter((member) => member.status !== "withdrawn");
  const reservations = Object.entries(record.joinRequests ?? {}).filter(([id, request]) => !members.some((member) => member.userId === id) && request.expiresAt > now && (request.status === "invited" || request.status === "approved" || request.status === "queued"));
  const ownReservation = reservations.some(([id]) => id === userId);
  return {
    kind: "lobby",
    language: record.language,
    classNames: texts[record.language].campaign.classes,
    campaignId: record.key.campaignId,
    campaignName: record.name,
    adventureTitle: bible.title,
    playerCount: record.lobby.members.filter((member) => member.status !== "withdrawn").length,
    maxPlayers: record.lobby.maxPlayers,
    canStart: record.organizerId === userId && startProblem === null,
    isOrganizer: record.organizerId === userId,
    isMember: ownMember !== undefined,
    canJoin: ownMember === undefined && record.lobby.status === "open" && (record.visibility !== "membersOnly" || record.organizerId === userId || ownReservation) && (ownReservation || members.length + reservations.length < record.lobby.maxPlayers),
    startBlockReason: startProblem === "notEnoughPlayers" || startProblem === "notReady" ? startProblem : null,
    selectedHeroId: ownMember?.heroId ?? null,
    selectedHeroName: selectedName,
    selectedHeroClass: selectedClass,
    members: record.lobby.members.filter((member) => member.status !== "withdrawn").map((member) => {
      const preset = heroes.find((hero) => hero.id === member.heroId);
      return {
        heroName: member.label?.name ?? preset?.name ?? (member.userId === userId ? texts[record.language].activity.lobby.memberChoose : texts[record.language].activity.lobby.memberChoosing),
        className: member.label?.className ?? preset?.class ?? null,
        ready: member.status === "ready",
        isYou: member.userId === userId,
      };
    }),
    heroChoices: heroes.map((hero) => ({ id: hero.id, name: hero.name, className: hero.class, available: !takenIds.has(hero.id) })),
    savedHeroChoices,
    houseRules: buildHouseRulesView(texts[record.language], record.houseRules, record.lifecycle === "lobby" && record.organizerId === userId),
  };
}

export function buildActivityTableView(
  record: CampaignRecord,
  state: CampaignState,
  bible: AdventureBible,
  content: SealedContent,
  glossary: Glossary,
  userId: UserId,
  heroes: readonly { readonly id: string; readonly name: string; readonly class: string }[],
  now: number,
  savedHeroChoices: readonly { readonly id: string; readonly name: string; readonly className: string; readonly imageUrl?: string }[] = [],
  events: readonly CampaignEvent[] = [],
): ActivityTableView {
  const panel = buildPanelView(record, state, bible, glossary);
  const names = { state, bible, glossary };
  const member = state.members[userId];
  const ownCharacterId = member?.characterId ?? null;
  const controlledHeroId = actingHero(state, userId);
  const sheet = ownCharacterId === null ? undefined : state.characters[ownCharacterId];
  const heroView = sheet === undefined ? null : buildHeroView(state, sheet, content);
  const scene = findScene(bible, state.sceneId);
  const explore = controlledHeroId === null || panel.mode === "combat"
    ? null
    : ((): ExploreView & { readonly shops: readonly ShopView[] } => {
      const view = buildExploreView(state, bible, content, glossary, controlledHeroId);
      return { ...view, shops: view.npcs.flatMap((npc) => {
        const shop = buildShopView(state, bible, glossary, resolveHouseRules(record.houseRules), controlledHeroId, npc.id);
        return shop === undefined ? [] : [shop];
      }) };
    })();
  const sharedMap = buildMapView(state, bible);
  const journeyMap: Extract<ActivityTableView["map"], { readonly kind: "journey" }> = {
    kind: "journey",
    nodes: sharedMap.nodes.map((node) => ({
      id: node.id,
      title: node.title ?? node.hint ?? "???",
      status: node.state === "current" ? "current" : node.state === "visited" ? "visited" : node.locked ? "locked" : explore?.places.some((place) => place.id === node.id) === true ? "reachable" : "known",
      locked: node.locked,
      deadEnd: node.deadEnd,
      canTravel: state.pendingMove === undefined && panel.mode !== "paused" && panel.mode !== "safety" && panel.mode !== "recovery" && explore?.places.some((place) => place.id === node.id) === true,
      column: node.column,
      row: node.row,
    })),
    routes: sharedMap.edges,
  };
  const roundSubmission = ownCharacterId === null ? undefined : state.round?.submissions[ownCharacterId];
  const joinRequest = record.joinRequests?.[userId];
  const inviteCurrent = joinRequest !== undefined && joinRequest.expiresAt > now;
  const turn = controlledHeroId === null || panel.mode !== "combat"
    ? null
    : buildTurnView(state, content, resolveHouseRules(record.houseRules), names, controlledHeroId);
  const publicParty: ActivityTableView["party"] = buildPartyView(state, content).map((hero) => {
    const partySheet = state.characters[hero.characterId];
    const raceId = partySheet?.race;
    return {
      characterId: hero.characterId,
      name: hero.name,
      className: hero.className,
      raceName: raceId === undefined ? null : glossary.names[raceId] ?? raceId,
      level: hero.level,
      hp: hero.hp,
      maxHp: hero.maxHp,
      armorClass: hero.armorClass,
      presence: hero.presence,
      down: hero.down,
      fallen: hero.fallen,
      conditions: hero.conditions,
      imageUrl: partySheet?.origin === undefined && !hasPicture(record.images?.[`hero:${hero.characterId}`]) ? null : `/api/activity/games/${encodeURIComponent(record.key.campaignId)}/images/characters/${encodeURIComponent(hero.characterId)}`,
      isYou: hero.ownerUserId === userId,
      ...(record.organizerId === userId && hero.ownerUserId !== userId && state.members[hero.ownerUserId]?.availability === "away" && (state.encounter === null || state.encounter.status === "ended") ? { seatUserId: hero.ownerUserId } : {}),
      zone: panel.combat?.party.find((combatant) => combatant.name === hero.name)?.zone ?? null,
      playedBy: ((): string | null => {
        const owner = state.members[hero.ownerUserId];
        const proxyUserId = state.proxies?.[hero.ownerUserId];
        const proxyHero = proxyUserId === undefined ? undefined : state.members[proxyUserId]?.characterId;
        return owner?.availability === "away" && proxyHero !== undefined && proxyHero !== null ? state.characters[proxyHero]?.name ?? null : null;
      })(),
      hitDice: ((): ActivityTableView["party"][number]["hitDice"] => {
        const sheet = state.characters[hero.characterId];
        if (sheet === undefined) return { left: 0, max: 0, die: null };
        const left = Math.min(sheet.level, state.heroStatus[sheet.id]?.hitDice ?? sheet.level);
        const pool = hitDicePool(sheet);
        return { left, max: sheet.level, die: pool[pool.length - left] ?? null };
      })(),
      concentration: panel.combat?.party.find((combatant) => combatant.name === hero.name)?.concentration ?? null,
      deathSaves: panel.combat?.party.find((combatant) => combatant.name === hero.name)?.deathSaves ?? null,
      statuses: panel.combat?.party.find((combatant) => combatant.name === hero.name)?.statuses ?? [],
      // What they said they would do this round: the Adventure channel posts it for everyone when it is sent.
      intent: ((): string | null => { const sent = state.round?.submissions[hero.characterId]; return sent?.kind === "action" ? sent.text.slice(0, 240) : null; })(),
      tableStatus: panel.combat?.party.some((combatant) => combatant.name === hero.name && combatant.active) === true
        ? "acting"
        : state.round?.submissions[hero.characterId]?.kind === "action" ? "submitted"
          : state.round?.submissions[hero.characterId]?.kind === "pass" ? "passed"
            : state.round?.submissions[hero.characterId]?.kind === "missed" ? "missed"
              : state.members[hero.ownerUserId]?.availability === "away" ? "away" : "waiting",
    };
  });
  const fullHero = heroView === null ? null : {
    characterId: heroView.characterId,
    imageUrl: sheet?.origin === undefined && !hasPicture(record.images?.[`hero:${heroView.characterId}`]) ? null : `/api/activity/games/${encodeURIComponent(record.key.campaignId)}/images/characters/${encodeURIComponent(heroView.characterId)}`,
    name: heroView.name,
    className: heroView.className,
    raceName: sheet?.race === undefined ? null : glossary.names[sheet.race] ?? sheet.race,
    level: heroView.level,
    hp: heroView.hp,
    maxHp: heroView.maxHp,
    armorClass: heroView.armorClass,
    gold: heroView.gold,
    partyGold: heroView.partyGold,
    weapons: heroView.weapons.map((id) => glossary.names[id] ?? id),
    worn: heroView.worn.map((id) => glossary.names[id] ?? id),
    pack: heroView.pack.map((item) => ({ ...item, name: glossary.names[item.id] ?? item.id })),
    stash: [...new Set(heroView.stash)].map((id) => ({ id, name: glossary.names[id] ?? id, count: heroView.stash.filter((item) => item === id).length })),
    inventoryChoices: [...new Set([...heroView.weapons, ...heroView.worn, ...heroView.pack.map((item) => item.id)])].map((id) => {
      const definition = content.find(id);
      const wearable = definition?.kind === "item" && (definition.itemType === "armor" || definition.itemType === "shield");
      return { id, name: glossary.names[id] ?? id, count: sheet?.equipment.filter((item) => item === id).length ?? 0, wearable, worn: heroView.worn.includes(id) };
    }),
    usablePotions: heroView.pack.flatMap((item) => {
      const definition = content.find(item.id);
      return definition?.kind === "item" && definition.itemType === "potion"
        ? [{ id: item.id, name: glossary.names[item.id] ?? item.id, count: item.count }]
        : [];
    }),
    cantrips: heroView.cantrips.map((id) => glossary.names[id] ?? id),
    prepared: heroView.prepared.map((id) => glossary.names[id] ?? id),
    slots: heroView.slots,
    pactSlots: heroView.pactSlots,
    uses: heroView.uses.map((use) => ({ ...use, name: glossary.names[use.id] ?? use.id })),
  };
  return {
    kind: "table",
    language: record.language,
    classNames: texts[record.language].campaign.classes,
    campaignId: record.key.campaignId,
    campaignName: record.name,
    adventureTitle: bible.title,
    sceneId: state.sceneId,
    mode: panel.mode,
    ownPresence: state.members[userId]?.availability ?? "away",
    canTogglePresence: state.members[userId] !== undefined,
    roundNumber: panel.roundNumber,
    journal: { journal: buildJournal(state, bible), places: buildPlaces(state, events, bible), recap: buildRecap(state, events, bible) },
    world: state.world === undefined ? null : { day: state.world.day, time: state.world.time, weather: state.world.weather ?? null },
    mapText: texts[record.language].campaign.map,
    // Show the encounter illustration during combat when it is ready; otherwise
    // keep the scene art visible. When combat ends, this naturally returns to scene art.
    scene: {
      title: panel.sceneTitle,
      description: scene?.publicDescription ?? "",
      imageUrl: panel.combat !== null && hasPicture(record.images?.[`encounter:${panel.combat.encounterId}`])
        ? `/api/activity/games/${encodeURIComponent(record.key.campaignId)}/images/encounters/${encodeURIComponent(panel.combat.encounterId)}`
        : scene === undefined ? null : `/api/activity/games/${encodeURIComponent(record.key.campaignId)}/images/scenes/${encodeURIComponent(scene.id)}`,
      ...(panel.combat !== null && hasPicture(record.images?.[`encounter:${panel.combat.encounterId}`]) && scene !== undefined
        ? { fallbackImageUrl: `/api/activity/games/${encodeURIComponent(record.key.campaignId)}/images/scenes/${encodeURIComponent(scene.id)}` }
        : {}),
    },
    pendingMove: state.pendingMove === undefined ? null : {
      sceneId: state.pendingMove.sceneId,
      present: presentMembers(state).length,
      needed: Math.ceil(presentMembers(state).length / 2),
      closesAt: state.round?.closesAt ?? null,
      sceneTitle: findScene(bible, state.pendingMove.sceneId)?.title ?? state.pendingMove.sceneId,
      sceneDescription: findScene(bible, state.pendingMove.sceneId)?.publicDescription ?? "",
      proposedBy: state.pendingMove.proposedBy === undefined
        ? state.pendingMove.heroes?.flatMap((id) => state.characters[id]?.name ?? []).join(", ") || null
        : (() => {
          const proposer = state.members[state.pendingMove!.proposedBy!];
          const characterId = proposer?.characterId;
          return characterId == null ? null : state.characters[characterId]?.name ?? characterId;
        })(),
      supporters: (state.pendingMove.supporters ?? []).flatMap((supporter) => {
        const characterId = state.members[supporter]?.characterId;
        return characterId == null ? [] : [state.characters[characterId]?.name ?? characterId];
      }),
      staying: state.pendingMove.objectors.flatMap((objector) => {
        const objectorHero = state.members[objector]?.characterId;
        return objectorHero === null || objectorHero === undefined ? [] : [state.characters[objectorHero]?.name ?? objectorHero];
      }),
      choiceByYou: state.pendingMove.objectors.includes(userId) ? "stay" : state.pendingMove.supporters?.includes(userId) ? "go" : null,
    },
    canVoteMove: state.pendingMove !== undefined && state.members[userId]?.availability === "present",
    map: panel.combat !== null && state.encounter !== null
      ? {
        kind: "battlefield",
        edges: state.encounter.edges,
        zones: state.encounter.zones.map((zone) => ({
          id: zone.id,
          name: zone.name,
          lighting: zone.lighting ?? null,
          cover: zone.cover ?? null,
          difficult: zone.difficult ?? false,
          canMove: turn?.moves.some((move) => move.zoneId === zone.id) ?? false,
          occupants: [
            ...panel.combat!.party.filter((hero) => hero.zone === zone.name).map((hero) => ({ name: hero.name, side: "party" as const, active: hero.active, hp: hero.hp, maxHp: hero.maxHp })),
            ...panel.combat!.foes.filter((foe) => foe.zone === zone.name).map((foe) => ({ name: foe.name, side: "foes" as const, ...(foe.rank === undefined ? {} : { rank: foe.rank }), active: foe.active, hp: foe.hp, maxHp: foe.maxHp })),
          ],
        })),
      }
      : journeyMap,
    hitDice: sheet === undefined ? null : ((): ActivityTableView["hitDice"] => {
      const status = state.heroStatus[sheet.id];
      const left = status?.hitDice ?? sheet.level;
      const pool = hitDicePool(sheet);
      const rolling = state.hitDicePending?.[sheet.id] !== undefined;
      const open = state.shortRestOpen === true && state.round === null && (state.encounter === null || state.encounter.status === "ended") && !isFallen(state, sheet.id);
      return { left, die: pool[pool.length - left] ?? null, canSpend: open && !rolling && left > 0 && (status?.hp ?? sheet.maxHp) < sheet.maxHp, rolling };
    })(),
    yourTurn: turn !== null,
    canBegin: record.organizerId === userId,
    controls: ((): ActivityTableView["controls"] => {
      const playing = record.lifecycle !== "archived" && state.pausedBy === null && panel.mode !== "paused";
      const organizer = record.organizerId === userId;
      return {
        canStop: playing && state.members[userId] !== undefined,
        canPause: playing && organizer,
        canReopen: organizer && record.lifecycle === "archived" && record.startedAt !== null,
        run: !playing || !organizer ? null : {
          closeRound: state.round?.status === "collecting",
          retry: state.round?.status === "planning",
          retryFight: state.encounter !== null && state.encounter.status === "ended" && state.encounter.outcome === "defeat" && state.fightCheckpoint !== null && (state.round === null || (state.round.status === "collecting" && Object.keys(state.round.submissions).length === 0)),
          retell: state.lastNarratedRound >= 1,
          illustrate: state.lastNarratedRound >= 1,
          illustrateScene: state.sceneId !== null,
          lowestLevel: Math.min(maxLevel, ...Object.values(state.characters).map((hero) => hero.level)),
          maxLevel,
          world: state.world === undefined ? null : { day: state.world.day, time: state.world.time, weather: state.world.weather ?? null },
          times: timesOfDay,
          weathers,
        },
        proxy: ownCharacterId === null ? null : { current: state.proxies?.[userId] ?? null, options: Object.values(state.members).filter((other) => other.userId !== userId && other.characterId !== null).map((other) => ({ userId: other.userId, heroName: state.characters[other.characterId ?? ""]?.name ?? "" })) },
        canPropose: playing && !organizer && ownCharacterId !== null && state.members[userId]?.availability !== "away" && state.resting === undefined && (state.restVote === undefined || state.restVote.closesAt <= now) && (state.status === "active" || state.status === "waitingForPlayers"),
        rest: !organizer || record.lifecycle === "archived" ? null : { askedFor: state.pendingRest?.rest ?? null, resting: state.resting ?? null, now: state.round === null && (state.encounter === null || state.encounter.status === "ended") },
      };
    })(),
    restVote: ((): ActivityTableView["restVote"] => {
      const vote = state.restVote;
      if (vote === undefined || vote.closesAt <= now) return null;
      const present = Object.values(state.members).filter((member) => member.characterId !== null && member.availability !== "away").map((member) => member.userId);
      const proposerHero = state.members[vote.proposedBy]?.characterId;
      return {
        rest: vote.rest,
        proposedBy: proposerHero === null || proposerHero === undefined ? "" : state.characters[proposerHero]?.name ?? "",
        agree: vote.agree.filter((id) => present.includes(id)).length,
        decline: vote.decline.filter((id) => present.includes(id)).length,
        needed: Math.floor(present.length / 2) + 1,
        present: present.length,
        yourAnswer: vote.agree.includes(userId) ? "agree" : vote.decline.includes(userId) ? "decline" : null,
        canAnswer: present.includes(userId),
        closesAt: vote.closesAt,
      };
    })(),
    companions: ownCharacterId === null ? [] : companionsOf(state.companions, ownCharacterId).map((companion) => ({ id: companion.id, name: glossary.names[companion.monsterId] ?? companion.monsterId, spellName: glossary.names[companion.spellId] ?? companion.spellId, hp: companion.hp })),
    canDismissCompanion: sheet !== undefined && !isFallen(state, sheet.id) && (state.encounter === null || state.encounter.status === "ended"),
    canSaveProgress: sheet !== undefined && sheet.origin !== undefined && (state.encounter === null || state.encounter.status === "ended") && !Object.values(state.checks).some((check) => check.status !== "resolved"),
    canRequestJoin: ownCharacterId === null && record.organizerId !== userId && record.visibility !== "membersOnly"
      && Object.keys(state.members).length + Object.entries(record.joinRequests ?? {}).filter(([id, request]) => state.members[id] === undefined && request.expiresAt > now && (request.status === "invited" || request.status === "approved" || request.status === "queued")).length < record.lobby.maxPlayers,
    joinEntrance: inviteCurrent ? joinRequest.entrance ?? null : null,
    activeName: panel.combat?.activeName ?? null,
    upcomingNames: panel.combat?.upcoming ?? [],
    order: panel.combat?.order ?? [],
    partySeats: Math.max(record.lobby.maxPlayers, publicParty.length),
    party: publicParty,
    foes: (panel.combat?.foes ?? []).map((foe) => ({ ...foe, statuses: foe.statuses ?? [] })),
    allies: (panel.combat?.allies ?? []).map((ally) => ({ ...ally, concentration: ally.concentration ?? null, statuses: ally.statuses ?? [] })),
    replacement: ((): ActivityTableView["replacement"] => {
      if (sheet === undefined || !isFallen(state, sheet.id) || record.lifecycle === "archived") return null;
      const living = Object.values(state.characters).filter((hero) => !isFallen(state, hero.id));
      const baseId = (id: string): string => id.replace(/-\d+$/, "");
      return {
        fallenName: sheet.name,
        partyLevel: Math.max(1, ...living.map((hero) => hero.level)),
        fightOn: state.encounter !== null && state.encounter.status !== "ended",
        options: heroes.filter((hero) => !living.some((alive) => baseId(alive.id) === hero.id)).map((hero) => ({ id: hero.id, name: hero.name, className: hero.class })),
        saved: savedHeroChoices,
      };
    })(),
    heroSheet: sheet === undefined ? null : buildHeroSheetView(sheet, state.heroStatus[sheet.id]?.hitDice, record.houseRules[levelingMode.id] === "milestone", glossary),
    levelUp: sheet === undefined ? null : buildLevelUpView(sheet, glossary),
    spellFacts: spellFactsByName([
      ...(heroView?.cantrips ?? []), ...(heroView?.prepared ?? []), ...(turn?.spells.map((spell) => spell.spellId) ?? []),
      ...(explore === null ? [] : [...explore.spells, ...explore.healing, ...explore.conjuring, ...explore.reviving].map((spell) => spell.id)),
    ], content, glossary),
    offers: Object.values(state.offers).flatMap((offer) => {
      const from = state.characters[offer.fromCharacterId];
      const to = state.characters[offer.toCharacterId];
      if (from === undefined || to === undefined || (from.ownerUserId !== userId && to.ownerUserId !== userId)) return [];
      return [{ id: offer.id, fromCharacterId: from.id, toCharacterId: to.id, fromName: from.name, toName: to.name, itemName: glossary.names[offer.give] ?? offer.give, direction: from.ownerUserId === userId ? "outgoing" as const : "incoming" as const }];
    }),
    myHero: fullHero,
    turn: turn === null ? null : nameTurn(turn, glossary),
    explore: controlledHeroId === null || state.pendingMove !== undefined || panel.mode !== "collecting"
      ? null
      : explore,
    pendingRoll: panel.pendingRolls.find((roll) => roll.userId === userId) === undefined
      ? null
      : ((): { readonly checkId: string; readonly test: CheckTest; readonly action: string | null } | null => {
        const roll = panel.pendingRolls.find((item) => item.userId === userId)!;
        const check = Object.values(state.checks).find((item) => item.characterId === roll.characterId && (item.status === "pending" || item.status === "rolling"));
        return check === undefined ? null : { checkId: check.id, test: roll.test, action: roll.action };
      })(),
    pendingRollCount: panel.pendingRolls.length,
    story: buildActivityStory(state, events, bible, glossary, ownCharacterId),
    rolls: ownCharacterId === null ? [] : recentRolls(state, ownCharacterId),
    submittedCount: state.round == null ? 0 : Object.values(state.round.submissions).filter((submission) => submission.kind === "action" || submission.kind === "pass").length,
    participantCount: state.round?.participants.length ?? 0,
    submission: roundSubmission?.kind === "action" ? "action" : roundSubmission?.kind ?? null,
    submissionText: roundSubmission?.kind === "action" ? roundSubmission.text : null,
    submissionRevision: roundSubmission?.kind === "action" ? roundSubmission.revision : null,
    canAcceptInvite: ownCharacterId === null && inviteCurrent && joinRequest?.status === "invited",
    joinRequestStatus: inviteCurrent ? joinRequest.status : null,
    queuedJoin: inviteCurrent && joinRequest?.status === "queued" && joinRequest.queuedHero !== undefined
      ? { heroName: joinRequest.queuedHero.name, encounterRound: state.encounter?.round ?? null, nextEncounter: state.pendingEncounter !== null }
      : null,
    joinChoices: ownCharacterId === null && inviteCurrent && joinRequest?.status === "approved"
      ? heroes.flatMap((hero) => Object.values(state.characters).some((existing) => !isFallen(state, existing.id) && (existing.id === hero.id || existing.id.startsWith(`${hero.id}-`)))
        ? []
        : [{ id: hero.id, name: hero.name, className: hero.class }])
      : [],
    savedHeroChoices: ownCharacterId === null && inviteCurrent && joinRequest?.status === "approved"
      ? savedHeroChoices
      : [],
    reaction: buildReactionView(state, bible, glossary),
    reactionIsYours: buildReactionView(state, bible, glossary)?.targetUserId === userId,
    smite: buildSmiteView(state, bible, glossary),
    smiteIsYours: buildSmiteView(state, bible, glossary)?.attackerUserId === userId,
    opportunityAttack: buildOpportunityAttackView(state, bible, glossary),
    opportunityAttackIsYours: buildOpportunityAttackView(state, bible, glossary)?.provokerUserId === userId,
  };
}

export function canSeeActivityCampaign(record: CampaignRecord, state: CampaignState | undefined, userId: UserId, now: number): boolean {
  if (record.visibility !== "membersOnly") return true;
  const participant = record.organizerId === userId
    || record.lobby.members.some((member) => member.userId === userId && member.status !== "withdrawn")
    || state?.members[userId] !== undefined;
  const invite = record.joinRequests?.[userId];
  const invited = invite !== undefined && invite.expiresAt > now && (invite.status === "invited" || invite.status === "approved" || invite.status === "queued");
  return participant || invited;
}

// The viewer's newest settled checks, oldest first, so a roll waiting in the dice dialog finds its own result even when another
// check settled in the same round. Presses (NPC dialogue) follow, as before.
function nameTurn(turn: TurnView, glossary: Glossary): ActivityTurnView {
  // A content id with no name in the glossary still reads as words rather than as an id.
  const named = (id: string): string => glossary.names[id] ?? id.replace(/^[a-z]+:/, "").replaceAll("-", " ");
  return {
    ...turn,
    attacks: turn.attacks.map((attack) => ({ ...attack, weaponName: named(attack.weapon.replace(/^(offhand:|nonlethal:)/, "")) })),
    spells: turn.spells.map((spell) => ({ ...spell, spellName: named(spell.spellId) })),
    features: turn.features.map((feature) => ({ ...feature, name: named(feature.id) })),
    potions: turn.potions.map((potion) => ({ ...potion, name: named(potion.id) })),
    teleports: turn.teleports.map((teleport) => ({ ...teleport, spellName: named(teleport.spellId) })),
    wildShapeChoices: turn.wildShapes.map((id) => ({ id, name: named(id) })),
  };
}

function recentRolls(state: CampaignState, characterId: string): ActivityTableView["rolls"] {
  const rollOf = (check: CampaignState["checks"][string]): ActivityTableView["rolls"][number] => ({ id: check.id, test: check.test, natural: check.result!.roll.d20.natural, total: check.result!.roll.total, dc: check.dc, success: check.result!.success, moment: check.result!.moments.headline?.kind === "natural20" || check.result!.moments.headline?.kind === "natural1" ? check.result!.moments.headline.kind : null });
  const checks = Object.values(state.checks).filter((check) => check.characterId === characterId && check.result !== null).sort((a, b) => a.roundNumber - b.roundNumber).slice(-3).map(rollOf);
  const presses = Object.values(state.dialogues).filter((dialogue) => dialogue.characterId === characterId && dialogue.check?.natural !== undefined).slice(-1)
    .map((dialogue) => ({ id: dialogue.id, test: dialogue.check!.test, natural: dialogue.check!.natural!, total: dialogue.check!.total, dc: dialogue.check!.dc, success: dialogue.check!.success, moment: dialogue.check!.moments.headline?.kind === "natural20" || dialogue.check!.moments.headline?.kind === "natural1" ? dialogue.check!.moments.headline.kind : null }));
  return [...checks, ...presses];
}
