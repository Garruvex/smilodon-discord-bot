import { randomUUID } from "node:crypto";

import type { CampaignLanguage } from "../../domain/campaign/adventure/adventure-bible.js";
import type { UserId } from "../../domain/campaign/core/ids.js";
import type { CharacterSheet } from "../../domain/campaign/character/character-sheet.js";
import * as lobbyRules from "../../domain/campaign/lobby/lobby.js";
import type { LobbyRefusal, LobbyResult } from "../../domain/campaign/lobby/lobby.js";
import { HouseRuleError, resolveHouseRules, startingLevelFor } from "../../domain/campaign/rules/house-rules.js";
import { KeyedSerialQueue } from "../concurrency/keyed-serial-queue.js";
import type { CampaignCommandBus } from "./campaign-command-bus.js";
import { emptyChannels, type CampaignRecord, type CampaignVisibility, type StoredRecord } from "./ports/campaign-record.js";
import type { AdventureLibrary } from "./ports/adventure-library.js";
import {
  RevisionConflictError,
  type CampaignKey,
  type CampaignUnitOfWork,
  type CommandOutcome,
  type RulesetPin,
} from "./ports/campaign-store.js";
import type { Clock } from "./ports/clock.js";
import { resolvePacing, type PacingChoice } from "./setup/pacing-presets.js";
import { checkCompatibility, type ImportConflict } from "./library/compatibility.js";
import type { CharacterLibrary } from "./library/character-library.js";
import { instantiateHero } from "./library/instantiate.js";
import { raiseToLevel } from "../../domain/campaign/character/leveling.js";
import { isFallen } from "../../domain/campaign/state/campaign-state.js";
import { libraryHeroRef, savedSnapshotIdOf, type LibrarySnapshot } from "./library/library-types.js";
import type { DerivedSheet } from "../../domain/campaign/character/character-build.js";
import type { RulesetCatalog } from "./rules/ruleset-catalog.js";
import { buildStartingState, StartingStateError, type Seat } from "./setup/starting-state.js";

export interface CreateCampaignInput {
  readonly guildId: string;
  readonly organizerId: UserId;
  readonly name: string;
  readonly language: CampaignLanguage;
  readonly adventureId: string;
  readonly pacing: PacingChoice;
  readonly houseRules?: Readonly<Record<string, string>>;
  readonly minPlayers?: number;
  readonly maxPlayers?: number;
  readonly visibility?: CampaignVisibility;
}

export type ServiceRefusal =
  | LobbyRefusal
  | "notFound"
  | "notLobby"
  | "notEnded"
  | "neverStarted"
  | "unknownAdventure"
  | "languageUnavailable"
  | "invalidName"
  | "nameTaken"
  | "invalidPacing"
  | "invalidHouseRules"
  | "libraryUnavailable"
  | "savedCharacterMissing"
  | "savedCharacterProblem"
  | "gameFull"
  | "joinNotApproved"
  | "joinAlreadyPlaying"
  | "joinNotAtBreak"
  | "invalidEntrance"
  | "privateInviteOnly"
  | "memberNotAway"
  | "organizerStays"
  | "inCombat";

// What choosing a saved character would bring, and what stands in the way.
export type SavedPreview =
  | { readonly kind: "ok"; readonly snapshot: LibrarySnapshot; readonly hero: DerivedSheet | null; readonly conflicts: readonly ImportConflict[] }
  | { readonly kind: "refused"; readonly reason: ServiceRefusal };

export type ChooseSavedResult = ServiceResult<CampaignRecord> | { readonly kind: "conflicts"; readonly conflicts: readonly ImportConflict[] };

export type ServiceResult<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "refused"; readonly reason: ServiceRefusal };

export interface ActivityCampaignListingItem {
  readonly campaignId: string;
  readonly name: string;
  readonly adventureTitle: string;
  readonly lifecycle: "lobby" | "active" | "paused";
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly canWatch: boolean;
  readonly action: "join" | "continue" | "request" | "requested" | "queued" | "invited" | "expired" | "full" | "resume";
}

export interface CampaignLobbyServiceOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly bus: CampaignCommandBus;
  readonly adventures: AdventureLibrary;
  readonly clock: Clock;
  // The ruleset new campaigns are pinned to, with its default house rules.
  readonly ruleset: RulesetPin;
  readonly newId?: () => string;
  // The character library and the rulesets it is checked against: without
  // them a saved character cannot be chosen.
  readonly library?: CharacterLibrary;
  readonly rulesets?: RulesetCatalog;
  // Called after a game starts, so the places it lives in can be adjusted (a
  // players-only game hides its channels then).
  readonly onStarted?: (key: CampaignKey) => void;
  // Called after a game is ended, to clear what it left behind (pictures waiting to be posted).
  readonly onEnded?: (key: CampaignKey) => void;
}

export const nameLimits = { min: 2, max: 60 } as const;

// Creating a campaign, its lobby, and starting play (plan §3). Every change
// to a campaign goes through one queue per campaign and a compare-and-set on
// the record, so two people clicking Join for the last seat cannot both get it.
export class CampaignLobbyService {
  private readonly queue = new KeyedSerialQueue();

  public constructor(private readonly options: CampaignLobbyServiceOptions) {}

  public async create(input: CreateCampaignInput): Promise<ServiceResult<CampaignRecord>> {
    const name = input.name.trim();
    if ([...name].length < nameLimits.min || [...name].length > nameLimits.max) return refused("invalidName");
    const document = this.options.adventures.document(input.adventureId, input.language);
    if (document === undefined) {
      return refused(this.options.adventures.list().some((adventure) => adventure.id === input.adventureId) ? "languageUnavailable" : "unknownAdventure");
    }
    const pacing = resolvePacing(input.pacing);
    if (!pacing.ok) return refused("invalidPacing");
    const houseRules = { ...this.options.ruleset.houseRules, ...input.houseRules };
    try {
      resolveHouseRules(houseRules);
    } catch (error) {
      if (error instanceof HouseRuleError) return refused("invalidHouseRules");
      throw error;
    }
    const lobby = lobbyRules.openLobby(input.minPlayers ?? 1, input.maxPlayers ?? Math.min(document.heroes.length, lobbyRules.lobbyLimits.maxPlayersCeiling));
    if (!lobby.ok) return refused(lobby.reason);

    const key: CampaignKey = { guildId: input.guildId, campaignId: (this.options.newId ?? randomUUID)() };
    const record: CampaignRecord = {
      key,
      name,
      organizerId: input.organizerId,
      language: input.language,
      lifecycle: "lobby",
      adventure: { adventureId: document.bible.id, version: document.bible.version },
      pacingPreset: input.pacing.preset,
      pacing: pacing.pacing,
      houseRules,
      lobby: lobby.lobby,
      channels: emptyChannels,
      pendingResources: [],
      visibility: input.visibility ?? "open",
      cards: {},
      createdAt: this.options.clock.now(),
      startedAt: null,
    };
    // Names become channel names, so they are unique among a server's unfinished campaigns.
    return this.options.unitOfWork.transaction(async (tx) => {
      const taken = (await tx.listRecords(input.guildId, ["lobby", "active", "paused"])).some(
        (stored) => stored.record.name.toLowerCase() === name.toLowerCase(),
      );
      if (taken) return refused("nameTaken");
      await tx.createRecord(record);
      return ok(record);
    });
  }

  public get(key: CampaignKey): Promise<StoredRecord | undefined> {
    return this.options.unitOfWork.transaction((tx) => tx.loadRecord(key));
  }

  // The campaign a message channel belongs to: its Party or Adventure post.
  public async findByChannel(guildId: string, channelIds: readonly string[]): Promise<StoredRecord | undefined> {
    const all = await this.list(guildId);
    return all.find(({ record }) => {
      const { partyPostId, adventurePostId } = record.channels;
      return [partyPostId, adventurePostId].some((id) => id !== null && channelIds.includes(id));
    });
  }

  public list(guildId: string): Promise<readonly StoredRecord[]> {
    return this.options.unitOfWork.transaction((tx) => tx.listRecords(guildId));
  }

  // Resolves a Discord Activity launched from a campaign's Party or Adventure
  // post to that game, while keeping the Activity's normal lobby as fallback.
  public async activityGameForChannel(guildId: string, userId: UserId, channelId: string): Promise<ActivityCampaignListingItem | null> {
    const games = await this.activityGames(guildId, userId);
    const stored = await this.findByChannel(guildId, [channelId]);
    if (stored !== undefined) return games.find((game) => game.campaignId === stored.record.key.campaignId) ?? null;
    // Started from somewhere that is not a game's own channel (the hub): a player in exactly one game goes straight into it instead of choosing from a list.
    const mine = games.filter((game) => game.action === "resume" || game.action === "continue");
    return mine.length === 1 ? (mine[0] ?? null) : null;
  }

  // A deliberately small, access-filtered projection for the Discord Activity lobby.
  public activityGames(guildId: string, userId: UserId): Promise<readonly ActivityCampaignListingItem[]> {
    return this.options.unitOfWork.transaction(async (tx) => {
      const records = await tx.listRecords(guildId, ["lobby", "active", "paused"]);
      const now = this.options.clock.now();
      const games: ActivityCampaignListingItem[] = [];
      for (const { record } of records) {
        if (record.lifecycle !== "lobby" && record.lifecycle !== "active" && record.lifecycle !== "paused") continue;
        if (record.lifecycle === "lobby" && record.lobby.status !== "open") continue;
        const storedCampaign = record.lifecycle === "lobby" ? undefined : await tx.loadCampaign(record.key);
        if (record.lifecycle !== "lobby" && storedCampaign === undefined) continue;
        const campaignMember = storedCampaign?.state.members[userId] !== undefined;
        const lobbyMember = record.lobby.members.some((member) => member.userId === userId && member.status !== "withdrawn");
        const organizer = record.organizerId === userId;
        const request = record.joinRequests?.[userId];
        const requestIsCurrent = request !== undefined && request.expiresAt > now;
        const invited = requestIsCurrent && (request.status === "invited" || request.status === "approved" || request.status === "queued");
        const participant = organizer || lobbyMember || campaignMember;
        const privateGame = record.visibility === "membersOnly";

        // A private campaign name, roster, and existence stay hidden unless the
        // player already belongs to it or has an unexpired invitation.
        // A private game stays hidden unless there is an invitation, or there was one that has since run out, which the player is told about.
        const expired = request !== undefined && !requestIsCurrent;
        const pending = requestIsCurrent && request.status === "requested";
        if (privateGame && !participant && !invited && !expired && !pending) continue;
        if (record.lifecycle === "lobby" && !participant && !invited && privateGame) continue;
        if (record.lifecycle !== "lobby" && !participant && !invited && !expired && !pending && privateGame) continue;

        const adventureTitle = this.options.adventures.documentAt(record.adventure.adventureId, record.adventure.version, record.language)?.bible.title
          ?? record.adventure.adventureId;
        if (record.lifecycle === "lobby") {
          const playerCount = lobbyRules.activeMembers(record.lobby).length;
          games.push({
            campaignId: record.key.campaignId,
            name: record.name,
            adventureTitle,
            lifecycle: record.lifecycle,
            playerCount,
            maxPlayers: record.lobby.maxPlayers,
            canWatch: !privateGame || participant || invited,
            action: participant ? "continue" : invited ? "join" : this.reservedSeats(record) >= record.lobby.maxPlayers ? "full" : "join",
          });
          continue;
        }

        const playerCount = Object.keys(storedCampaign?.state.members ?? {}).length;
        const action = participant
          ? "resume"
          : requestIsCurrent && request.status === "queued"
            ? "queued"
            : invited
            ? "invited"
            : requestIsCurrent && request.status === "requested"
              ? "requested"
              : expired
                ? "expired"
                : this.reservedSeats(record) >= record.lobby.maxPlayers ? "full" : "request";
        games.push({
          campaignId: record.key.campaignId,
          name: record.name,
          adventureTitle,
          lifecycle: record.lifecycle,
          playerCount,
          maxPlayers: record.lobby.maxPlayers,
          canWatch: !privateGame || participant || invited,
          action,
        });
      }
      return games.sort((left, right) => {
        const lifecycleOrder = { lobby: 0, active: 1, paused: 2 } as const;
        return lifecycleOrder[left.lifecycle] - lifecycleOrder[right.lifecycle] || left.name.localeCompare(right.name);
      });
    });
  }

  public async joinFromActivity(key: CampaignKey, userId: UserId): Promise<ServiceResult<CampaignRecord>> {
    return this.queue.run(queueKey(key), () => this.options.unitOfWork.transaction(async (tx) => {
      const stored = await tx.loadRecord(key);
      if (stored === undefined) return refused("notFound");
      const { record } = stored;
      if (record.lifecycle !== "lobby") return refused("notLobby");
      const existing = lobbyRules.activeMembers(record.lobby).some((member) => member.userId === userId);
      const invitation = record.joinRequests?.[userId];
      const hasInvitation = invitation !== undefined && invitation.expiresAt > this.options.clock.now()
        && (invitation.status === "invited" || invitation.status === "approved");
      if (record.visibility === "membersOnly" && record.organizerId !== userId && !existing && !hasInvitation) return refused("privateInviteOnly");
      if (!existing && !hasInvitation && this.reservedSeats(record) >= record.lobby.maxPlayers) return refused("full");
      const result = lobbyRules.join(record.lobby, userId);
      if (!result.ok) return refused(result.reason);
      const joinRequests = { ...(record.joinRequests ?? {}) };
      delete joinRequests[userId];
      const next = { ...record, lobby: result.lobby, joinRequests };
      await tx.saveRecord(next, stored.revision);
      return ok(next);
    }));
  }

  public inviteLobby(key: CampaignKey, actorId: UserId, userId: UserId): Promise<ServiceResult<CampaignRecord>> {
    return this.queue.run(queueKey(key), () => this.options.unitOfWork.transaction(async (tx) => {
      const stored = await tx.loadRecord(key);
      if (stored === undefined) return refused("notFound");
      const { record } = stored;
      if (record.organizerId !== actorId) return refused("notOrganizer");
      if (record.lifecycle !== "lobby" || record.lobby.status !== "open") return refused("notLobby");
      if (lobbyRules.activeMembers(record.lobby).some((member) => member.userId === userId)) return refused("joinAlreadyPlaying");
      const current = record.joinRequests?.[userId];
      const reserved = current?.status === "invited" && current.expiresAt > this.options.clock.now();
      if (!reserved && this.reservedSeats(record) >= record.lobby.maxPlayers) return refused("gameFull");
      const next: CampaignRecord = { ...record, joinRequests: { ...(record.joinRequests ?? {}), [userId]: { status: "invited", expiresAt: this.options.clock.now() + 7 * 24 * 60 * 60 * 1000 } } };
      await tx.saveRecord(next, stored.revision);
      return ok(next);
    }));
  }

  public join(key: CampaignKey, userId: UserId): Promise<ServiceResult<CampaignRecord>> {
    return this.change(key, (lobby, record) => {
      const alreadySeated = lobbyRules.activeMembers(lobby).some((member) => member.userId === userId);
      const invite = record.joinRequests?.[userId];
      const reserved = invite !== undefined && invite.expiresAt > this.options.clock.now() && (invite.status === "invited" || invite.status === "approved");
      if (!alreadySeated && !reserved && this.reservedSeats(record) >= lobby.maxPlayers) return { ok: false, reason: "full" };
      return lobbyRules.join(lobby, userId);
    });
  }

  // A running public game accepts applications. A private game can only be
  // entered through an organizer invitation.
  public requestOngoingJoin(key: CampaignKey, userId: UserId): Promise<ServiceResult<CampaignRecord>> {
    return this.changeJoinRequest(key, userId, (record, playing) => {
      const current = record.joinRequests?.[userId];
      // Someone whose invitation to a private game ran out may ask again; otherwise a private game is entered by invitation only.
      if (record.visibility === "membersOnly" && current === undefined) return "privateInviteOnly";
      if (playing) return "joinAlreadyPlaying";
      if (current !== undefined && current.expiresAt > this.options.clock.now()) return current;
      if (this.reservedSeats(record) >= record.lobby.maxPlayers) return "gameFull";
      return { status: "requested", expiresAt: this.options.clock.now() + 7 * 24 * 60 * 60 * 1000 };
    });
  }

  // The players who are marked away right now, with their hero, for the organizer to pick whose seat to free.
  public async awaySeats(key: CampaignKey): Promise<readonly { readonly userId: UserId; readonly heroName: string | null }[]> {
    const campaign = await this.options.unitOfWork.transaction((tx) => tx.loadCampaign(key));
    if (campaign === undefined) return [];
    const { state } = campaign;
    return Object.values(state.members)
      .filter((member) => member.availability === "away" && member.userId !== state.organizerId)
      .map((member) => ({ userId: member.userId, heroName: member.characterId === null ? null : (state.characters[member.characterId]?.name ?? null) }));
  }

  // The organizer frees an away player's seat: the hero leaves the table, and the seat, and any request the player had, are released so someone else can be invited into it.
  public retireSeat(key: CampaignKey, actorId: UserId, userId: UserId, interactionId: string): Promise<ServiceResult<CampaignRecord>> {
    return this.queue.run(queueKey(key), async () => {
      const stored = await this.options.unitOfWork.transaction((tx) => tx.loadRecord(key));
      if (stored === undefined) return refused("notFound");
      if (stored.record.lifecycle !== "active" && stored.record.lifecycle !== "paused") return refused("closed");
      if (stored.record.organizerId !== actorId) return refused("notOrganizer");
      const outcome = await this.options.bus.execute(key, { kind: "retireMember", userId }, { commandId: `dnd:${interactionId}`, actor: { kind: "user", userId: actorId } });
      if (outcome.kind === "notFound") return refused("notFound");
      if (outcome.kind === "rejected") {
        const code = outcome.rejection.code;
        return refused(code === "memberNotAway" || code === "organizerStays" || code === "inCombat" || code === "notOrganizer" ? code : "notMember");
      }
      const next = await this.options.unitOfWork.transaction(async (tx) => {
        const latest = await tx.loadRecord(key);
        if (latest === undefined) return undefined;
        const joinRequests = { ...(latest.record.joinRequests ?? {}) };
        delete joinRequests[userId];
        const updated: CampaignRecord = { ...latest.record, joinRequests, lobby: { ...latest.record.lobby, members: latest.record.lobby.members.filter((member) => member.userId !== userId) } };
        await tx.saveRecord(updated, latest.revision);
        return updated;
      });
      return next === undefined ? refused("notFound") : ok(next);
    });
  }

  public withdrawOngoingJoin(key: CampaignKey, userId: UserId): Promise<ServiceResult<CampaignRecord>> {
    return this.changeJoinRequest(key, userId, (record) => {
      const current = record.joinRequests?.[userId];
      if (current === undefined) return "notMember";
      if (current.status === "requested") return null;
      if (current.status === "queued") {
        const { queuedHero: _queuedHero, queueId: _queueId, ...approved } = current;
        return { ...approved, status: "approved" };
      }
      return "notMember";
    });
  }

  public inviteOngoing(key: CampaignKey, actorId: UserId, userId: UserId, entrance: string): Promise<ServiceResult<CampaignRecord>> {
    return this.changeJoinRequest(key, userId, (record, playing, reserved) => {
      if (record.organizerId !== actorId) return "notOrganizer";
      if (playing) return "joinAlreadyPlaying";
      if (!reserved && this.reservedSeats(record) >= record.lobby.maxPlayers) return "gameFull";
      const phrase = entrance.trim();
      if (phrase.length < 1 || phrase.length > 500) return "invalidEntrance";
      return { status: "invited", entrance: phrase, expiresAt: this.options.clock.now() + 7 * 24 * 60 * 60 * 1000 };
    });
  }

  public decideOngoingJoin(key: CampaignKey, actorId: UserId, userId: UserId, approve: boolean, entrance = ""): Promise<ServiceResult<CampaignRecord>> {
    return this.changeJoinRequest(key, userId, (record, playing, reserved) => {
      if (record.organizerId !== actorId) return "notOrganizer";
      if (record.joinRequests?.[userId]?.status !== "requested" || (record.joinRequests?.[userId]?.expiresAt ?? 0) <= this.options.clock.now()) return "notMember";
      if (playing) return "joinAlreadyPlaying";
      if (!approve) return null;
      if (!reserved && this.reservedSeats(record) >= record.lobby.maxPlayers) return "gameFull";
      const phrase = entrance.trim();
      if (phrase.length < 1 || phrase.length > 500) return "invalidEntrance";
      return { status: "approved", entrance: phrase, expiresAt: this.options.clock.now() + 7 * 24 * 60 * 60 * 1000 };
    });
  }

  public acceptOngoingInvite(key: CampaignKey, userId: UserId): Promise<ServiceResult<CampaignRecord>> {
    return this.changeJoinRequest(key, userId, (record) => {
      const current = record.joinRequests?.[userId];
      if (current?.status !== "invited" || current.expiresAt <= this.options.clock.now()) return "joinNotApproved";
      return { ...current, status: "approved" };
    });
  }

  public async joinOngoingHero(key: CampaignKey, userId: UserId, heroRef: string, interactionId: string): Promise<ServiceResult<CampaignRecord>> {
    return this.queue.run(queueKey(key), async () => {
      const loaded = await this.options.unitOfWork.transaction(async (tx) => ({ stored: await tx.loadRecord(key), campaign: await tx.loadCampaign(key) }));
      if (loaded.stored === undefined || loaded.campaign === undefined) return refused("notFound");
      const { record } = loaded.stored;
      const state = loaded.campaign.state;
      if (record.lifecycle !== "active" && record.lifecycle !== "paused") return refused("closed");
      const request = record.joinRequests?.[userId];
      if ((request?.status !== "approved" && request?.status !== "queued") || request.expiresAt <= this.options.clock.now()) return refused("joinNotApproved");
      if (state.members[userId]?.characterId != null) {
        return this.finishOngoingJoin(key, userId, state.members[userId]!.characterId!);
      }
      if (state.members[userId] === undefined && Object.keys(state.members).length >= record.lobby.maxPlayers) return refused("gameFull");
      const prepared = await this.ongoingHeroSheet(record, state, userId, heroRef);
      if (prepared.kind === "refused") return prepared;
      const joining = prepared.value;
      if (await this.mustWaitForFight(key, state)) {
        const joinRequests = { ...(record.joinRequests ?? {}), [userId]: { ...request, status: "queued" as const, queuedHero: joining, queueId: interactionId } };
        const updated: CampaignRecord = { ...record, joinRequests };
        await this.options.unitOfWork.transaction((tx) => tx.saveRecord(updated, loaded.stored!.revision));
        return ok(updated);
      }
      const partyLevel = Math.max(1, ...Object.values(state.characters).filter((hero) => !isFallen(state, hero.id)).map((hero) => hero.level));
      const outcome = await this.options.bus.execute(key, { kind: "joinHero", sheet: raiseToLevel(joining, partyLevel), entrance: request.entrance ?? "A new companion joins the party." }, { commandId: `dnd:${interactionId}`, actor: { kind: "user", userId } });
      if (outcome.kind !== "accepted") return refused(outcome.kind === "notFound" ? "notFound" : "savedCharacterProblem");
      return this.finishOngoingJoin(key, userId, joining.id);
    });
  }

  // The runtime checks these reservations after combat's closing narration and
  // joins each selected hero at the first safe break. Requests remain on the
  // campaign record, so a restart cannot lose someone's place in the queue.
  public async processQueuedJoins(): Promise<{ readonly processed: number; readonly failed: readonly { readonly id: string; readonly error: string }[] }> {
    const records = await this.options.unitOfWork.transaction((tx) => tx.listRecordsByLifecycle(["active", "paused"]));
    const failed: { id: string; error: string }[] = [];
    let processed = 0;
    for (const { record } of records) {
      for (const [userId, request] of Object.entries(record.joinRequests ?? {})) {
        if (request.status !== "queued" || request.queuedHero === undefined || request.expiresAt <= this.options.clock.now()) continue;
        try {
          const joined = await this.queue.run(queueKey(record.key), async () => {
            const latest = await this.options.unitOfWork.transaction(async (tx) => ({ stored: await tx.loadRecord(record.key), campaign: await tx.loadCampaign(record.key) }));
            if (latest.stored === undefined || latest.campaign === undefined) return false;
            const currentRequest = latest.stored.record.joinRequests?.[userId];
            const state = latest.campaign.state;
            if (currentRequest?.status !== "queued" || currentRequest.queuedHero === undefined || currentRequest.expiresAt <= this.options.clock.now()) return false;
            if (state.members[userId]?.characterId != null) {
              const result = await this.finishOngoingJoin(record.key, userId, state.members[userId]!.characterId!);
              return result.kind === "ok";
            }
            if (await this.mustWaitForFight(record.key, state)) return false;
            if (state.members[userId] === undefined && Object.keys(state.members).length >= latest.stored.record.lobby.maxPlayers) {
              await this.returnQueuedJoinToApproval(record.key, userId, currentRequest.queueId);
              return false;
            }
            const partyLevel = Math.max(1, ...Object.values(state.characters).filter((hero) => !isFallen(state, hero.id)).map((hero) => hero.level));
            const commandId = `dnd:queued-join:${currentRequest.queueId ?? currentRequest.expiresAt}`;
            const outcome = await this.options.bus.execute(record.key, { kind: "joinHero", sheet: raiseToLevel(currentRequest.queuedHero, partyLevel), entrance: currentRequest.entrance ?? "A new companion joins the party." }, { commandId, actor: { kind: "user", userId } });
            if (outcome.kind !== "accepted") {
              await this.returnQueuedJoinToApproval(record.key, userId, currentRequest.queueId);
              return false;
            }
            const result = await this.finishOngoingJoin(record.key, userId, currentRequest.queuedHero.id);
            return result.kind === "ok";
          });
          if (joined) processed += 1;
        } catch (error) {
          failed.push({ id: `${record.key.campaignId}:${userId}`, error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    return { processed, failed };
  }

  // A hero joins at a safe break: not while a fight is on or about to start, and not before its closing narration is told. A closing narration that was given up on (the Narrator failed every attempt) is not waited for, or nobody could ever join after that fight.
  private async mustWaitForFight(key: CampaignKey, state: import("../../domain/campaign/state/campaign-state.js").CampaignState): Promise<boolean> {
    if (state.pendingEncounter !== null) return true;
    const encounter = state.encounter;
    if (encounter === null) return false;
    if (encounter.status !== "ended") return true;
    if (encounter.narratedRound >= encounter.round) return false;
    const work = await this.options.unitOfWork.transaction((tx) => tx.outboxForCampaign(key));
    return work.some((item) => item.status === "pending" && item.request.kind === "narrateCombat");
  }

  private async ongoingHeroSheet(record: CampaignRecord, state: import("../../domain/campaign/state/campaign-state.js").CampaignState, userId: UserId, heroRef: string): Promise<ServiceResult<CharacterSheet>> {
    const snapshotId = savedSnapshotIdOf(heroRef);
    let sheet: CharacterSheet;
    if (snapshotId !== null) {
      if (this.options.library === undefined || this.options.rulesets === undefined) return refused("libraryUnavailable");
      const snapshot = await this.options.library.snapshot(userId, snapshotId);
      if (snapshot === undefined) return refused("savedCharacterMissing");
      const content = this.options.rulesets.resolve({ ...this.options.ruleset, houseRules: record.houseRules }).content;
      if (checkCompatibility(snapshot, content).length > 0) return refused("savedCharacterProblem");
      sheet = { ...instantiateHero(snapshot, record.houseRules), ownerUserId: userId };
    } else {
      const preset = this.options.adventures.documentAt(record.adventure.adventureId, record.adventure.version, record.language)?.heroes.find((hero) => hero.id === heroRef);
      if (preset === undefined) return refused("unknownHero");
      const { class: className, ...rest } = preset;
      const queuedIds = Object.values(record.joinRequests ?? {}).flatMap((request) => request.status === "queued" && request.queuedHero !== undefined ? [request.queuedHero.id] : []);
      const used = Object.keys(state.characters).filter((id) => id === preset.id || id.startsWith(`${preset.id}-`)).length
        + queuedIds.filter((id) => id === preset.id || id.startsWith(`${preset.id}-`)).length;
      sheet = { ...rest, id: used === 0 ? preset.id : `${preset.id}-${used + 1}`, className, ownerUserId: userId };
    }
    const partyLevel = Math.max(1, ...Object.values(state.characters).filter((hero) => !isFallen(state, hero.id)).map((hero) => hero.level));
    if (sheet.level > partyLevel) return refused("savedCharacterProblem");
    return ok(sheet);
  }

  private async finishOngoingJoin(key: CampaignKey, userId: UserId, heroRef: string): Promise<ServiceResult<CampaignRecord>> {
      const next = await this.options.unitOfWork.transaction(async (tx) => {
        const latest = await tx.loadRecord(key);
        if (latest === undefined) return undefined;
        const joinRequests = { ...(latest.record.joinRequests ?? {}) };
        delete joinRequests[userId];
        const members = latest.record.lobby.members.some((member) => member.userId === userId)
          ? latest.record.lobby.members.map((member) => member.userId === userId ? { ...member, heroId: heroRef, status: "ready" as const } : member)
          : [...latest.record.lobby.members, { userId, heroId: heroRef, status: "ready" as const }];
        const updated: CampaignRecord = { ...latest.record, joinRequests, lobby: { ...latest.record.lobby, members } };
        await tx.saveRecord(updated, latest.revision);
        return updated;
      });
      return next === undefined ? refused("notFound") : ok(next);
  }

  private async returnQueuedJoinToApproval(key: CampaignKey, userId: UserId, queueId: string | undefined): Promise<void> {
    await this.options.unitOfWork.transaction(async (tx) => {
      const latest = await tx.loadRecord(key);
      const request = latest?.record.joinRequests?.[userId];
      if (latest === undefined || request?.status !== "queued" || request.queueId !== queueId) return;
      const { queuedHero: _queuedHero, queueId: _queueId, ...approved } = request;
      const joinRequests = { ...latest.record.joinRequests, [userId]: { ...approved, status: "approved" as const } };
      await tx.saveRecord({ ...latest.record, joinRequests }, latest.revision);
    });
  }

  private reservedSeats(record: CampaignRecord): number {
    const members = lobbyRules.activeMembers(record.lobby);
    return members.length + Object.entries(record.joinRequests ?? {}).filter(([userId, request]) => !members.some((member) => member.userId === userId) && (request.status === "invited" || request.status === "approved" || request.status === "queued") && request.expiresAt > this.options.clock.now()).length;
  }

  private changeJoinRequest(key: CampaignKey, userId: UserId, decide: (record: CampaignRecord, playing: boolean, reserved: boolean) => NonNullable<CampaignRecord["joinRequests"]>[string] | ServiceRefusal | null): Promise<ServiceResult<CampaignRecord>> {
    return this.queue.run(queueKey(key), () => this.options.unitOfWork.transaction(async (tx) => {
      const stored = await tx.loadRecord(key);
      const campaign = await tx.loadCampaign(key);
      if (stored === undefined || campaign === undefined) return refused("notFound");
      const { record } = stored;
      if (record.lifecycle !== "active" && record.lifecycle !== "paused") return refused("closed");
      const playing = campaign.state.members[userId]?.characterId != null;
      const request = record.joinRequests?.[userId];
      const reserved = request !== undefined && request.expiresAt > this.options.clock.now() && (request.status === "invited" || request.status === "approved" || request.status === "queued");
      const result = decide(record, playing, reserved);
      if (typeof result === "string") return refused(result);
      const joinRequests = { ...(record.joinRequests ?? {}) };
      if (result === null) delete joinRequests[userId];
      else joinRequests[userId] = result;
      const next: CampaignRecord = { ...record, joinRequests };
      await tx.saveRecord(next, stored.revision);
      return ok(next);
    }));
  }

  public leave(key: CampaignKey, userId: UserId): Promise<ServiceResult<CampaignRecord>> {
    return this.change(key, (lobby) => lobbyRules.leave(lobby, userId));
  }

  public removeMember(key: CampaignKey, actorId: UserId, userId: UserId): Promise<ServiceResult<CampaignRecord>> {
    return this.change(key, (lobby, record) => lobbyRules.remove(lobby, actorId, record.organizerId, userId));
  }

  public chooseHero(key: CampaignKey, userId: UserId, heroId: string): Promise<ServiceResult<CampaignRecord>> {
    return this.change(key, (lobby, record) => {
      const heroes = this.options.adventures.documentAt(record.adventure.adventureId, record.adventure.version, record.language)?.heroes ?? [];
      return lobbyRules.chooseHero(lobby, userId, heroId, heroes.map((hero) => hero.id));
    });
  }

  public cancel(key: CampaignKey, actorId: UserId): Promise<ServiceResult<CampaignRecord>> {
    return this.change(key, (lobby, record) => lobbyRules.cancel(lobby, actorId, record.organizerId), "archived");
  }

  // Ends a game for good: the record is archived and, if it was being played,
  // the engine is paused so no timer or DM job runs on it. The caller has
  // already checked the actor may (the organizer, or a DnD Admin).
  public end(key: CampaignKey): Promise<ServiceResult<CampaignRecord>> {
    return this.queue.run(queueKey(key), async () => {
      const ended = await this.options.unitOfWork.transaction(async (tx): Promise<ServiceResult<CampaignRecord>> => {
        const stored = await tx.loadRecord(key);
        if (stored === undefined) return refused("notFound");
        if (stored.record.lifecycle === "archived") return ok(stored.record);
        const next: CampaignRecord = { ...stored.record, lifecycle: "archived" };
        await tx.saveRecord(next, stored.revision);
        return ok(next);
      });
      if (ended.kind === "refused") return ended;
      // Stops the clock. Refused when it is already paused or never started, which is fine.
      await this.options.bus.execute(key, { kind: "pauseCampaign", reason: "organizer" }, { commandId: `end:${key.campaignId}`, actor: { kind: "system" } });
      this.options.onEnded?.(key);
      return ended;
    });
  }

  // What a saved character would bring into this game, and every conflict
  // that stops it. The owner sees this before confirming; only their own
  // characters can be previewed.
  public async previewSaved(key: CampaignKey, userId: UserId, snapshotId: string): Promise<SavedPreview> {
    const { library, rulesets } = this.options;
    if (library === undefined || rulesets === undefined) return { kind: "refused", reason: "libraryUnavailable" };
    const stored = await this.options.unitOfWork.transaction((tx) => tx.loadRecord(key));
    if (stored === undefined) return { kind: "refused", reason: "notFound" };
    if (stored.record.lifecycle !== "lobby") return { kind: "refused", reason: "notLobby" };
    const snapshot = await library.snapshot(userId, snapshotId);
    if (snapshot === undefined) return { kind: "refused", reason: "savedCharacterMissing" };
    const content = rulesets.resolve({ ...this.options.ruleset, houseRules: stored.record.houseRules }).content;
    const conflicts = checkCompatibility(snapshot, content);
    // A build with a problem has no hero to show.
    const broken = conflicts.some((conflict) => conflict.code === "invalidBuild");
    return { kind: "ok", snapshot, hero: broken ? null : instantiateHero(snapshot, stored.record.houseRules), conflicts };
  }

  // Seats the player with a saved character, when nothing stands in the way.
  public chooseSaved(key: CampaignKey, userId: UserId, snapshotId: string): Promise<ChooseSavedResult> {
    return this.queue.run(queueKey(key), async () => {
      const preview = await this.previewSaved(key, userId, snapshotId);
      if (preview.kind === "refused") return refused(preview.reason);
      if (preview.conflicts.length > 0 || preview.hero === null) return { kind: "conflicts", conflicts: preview.conflicts };
      const ref = libraryHeroRef(snapshotId);
      const label = { name: preview.hero.name, className: preview.hero.className ?? "" };
      return this.options.unitOfWork.transaction(async (tx): Promise<ServiceResult<CampaignRecord>> => {
        const stored = await tx.loadRecord(key);
        if (stored === undefined) return refused("notFound");
        if (stored.record.lifecycle !== "lobby") return refused("notLobby");
        const result = lobbyRules.chooseHero(stored.record.lobby, userId, ref, [ref], label);
        if (!result.ok) return refused(result.reason);
        const next: CampaignRecord = { ...stored.record, lobby: result.lobby };
        await tx.saveRecord(next, stored.revision);
        return ok(next);
      });
    });
  }

  // The organizer (null: a DnD Admin acting for them) changes how many players the game takes, in the lobby or while it is being played.
  // It never goes below the players already seated.
  public setPartySize(key: CampaignKey, actorId: UserId | null, maxPlayers: number): Promise<ServiceResult<CampaignRecord>> {
    return this.queue.run(queueKey(key), () =>
      this.options.unitOfWork.transaction(async (tx): Promise<ServiceResult<CampaignRecord>> => {
        const stored = await tx.loadRecord(key);
        if (stored === undefined) return refused("notFound");
        const { record } = stored;
        if (record.lifecycle === "archived") return refused("closed");
        if (actorId !== null && record.organizerId !== actorId) return refused("notOrganizer");
        const campaign = await tx.loadCampaign(key);
        const seated = Math.max(this.reservedSeats(record), Object.keys(campaign?.state.members ?? {}).length);
        const resized = lobbyRules.resize(record.lobby, maxPlayers, seated);
        if (!resized.ok) return refused(resized.reason);
        if (resized.lobby === record.lobby) return ok(record);
        const next: CampaignRecord = { ...record, lobby: resized.lobby };
        await tx.saveRecord(next, stored.revision);
        return ok(next);
      }),
    );
  }

  // Changes house-rule options while the game is still in its lobby, for the
  // organizer only. Every value is checked against the options the engine
  // implements; nothing else can be saved.
  public setHouseRules(key: CampaignKey, actorId: UserId, changes: Readonly<Record<string, string>>): Promise<ServiceResult<CampaignRecord>> {
    return this.queue.run(queueKey(key), () =>
      this.options.unitOfWork.transaction(async (tx): Promise<ServiceResult<CampaignRecord>> => {
        const stored = await tx.loadRecord(key);
        if (stored === undefined) return refused("notFound");
        const { record } = stored;
        if (record.lifecycle !== "lobby") return refused("notLobby");
        if (record.organizerId !== actorId) return refused("notOrganizer");
        const houseRules = { ...record.houseRules, ...changes };
        try {
          resolveHouseRules(houseRules);
        } catch (error) {
          if (error instanceof HouseRuleError) return refused("invalidHouseRules");
          throw error;
        }
        const next: CampaignRecord = { ...record, houseRules };
        await tx.saveRecord(next, stored.revision);
        return ok(next);
      }),
    );
  }

  // Opens an ended game again (the organizer, or a DnD Admin, has been checked
  // by the caller). The game comes back paused, exactly where it stopped; the
  // organizer resumes it. A game cancelled in its lobby never began, and a
  // name another unfinished game has taken since is not given twice.
  public reopen(key: CampaignKey): Promise<ServiceResult<CampaignRecord>> {
    return this.queue.run(queueKey(key), () =>
      this.options.unitOfWork.transaction(async (tx): Promise<ServiceResult<CampaignRecord>> => {
        const stored = await tx.loadRecord(key);
        if (stored === undefined) return refused("notFound");
        const { record } = stored;
        if (record.lifecycle !== "archived") return refused("notEnded");
        if (record.startedAt === null || (await tx.loadCampaign(key)) === undefined) return refused("neverStarted");
        const taken = (await tx.listRecords(key.guildId, ["lobby", "active", "paused"])).some((other) => other.record.name.toLowerCase() === record.name.toLowerCase());
        if (taken) return refused("nameTaken");
        const next: CampaignRecord = { ...record, lifecycle: "active" };
        await tx.saveRecord(next, stored.revision);
        return ok(next);
      }),
    );
  }

  // Starts play: the engine campaign is created from the lobby's seats and the
  // record moves to active in one transaction, then the opening is
  // asked for (the first round follows it). If the process stops between the
  // two, the campaign is active with nothing begun, and the startup recovery
  // begins it (the command is idempotent).
  public start(key: CampaignKey, actorId: UserId): Promise<ServiceResult<{ readonly record: CampaignRecord; readonly firstRound: CommandOutcome }>> {
    return this.queue.run(queueKey(key), async () => {
      const started = await this.options.unitOfWork.transaction(async (tx): Promise<ServiceResult<CampaignRecord>> => {
        const stored = await tx.loadRecord(key);
        if (stored === undefined) return refused("notFound");
        const { record } = stored;
        if (record.lifecycle !== "lobby") return refused("notLobby");
        const result = lobbyRules.start(record.lobby, actorId, record.organizerId);
        if (!result.ok) return refused(result.reason);
        const document = this.options.adventures.documentAt(record.adventure.adventureId, record.adventure.version, record.language);
        if (document === undefined) return refused("unknownAdventure");
        const seats: Seat[] = [];
        for (const member of lobbyRules.activeMembers(result.lobby)) {
          if (member.heroId === null) continue;
          const snapshotId = savedSnapshotIdOf(member.heroId);
          if (snapshotId === null) {
            seats.push({ userId: member.userId, heroId: member.heroId });
            continue;
          }
          // A saved character is checked again at the start: it may have been
          // deleted, or the rules changed, since it was chosen.
          const snapshot = await tx.loadLibrarySnapshot(snapshotId);
          const rulesets = this.options.rulesets;
          if (snapshot === undefined || snapshot.ownerUserId !== member.userId || rulesets === undefined) return refused("savedCharacterProblem");
          const content = rulesets.resolve({ ...this.options.ruleset, houseRules: record.houseRules }).content;
          if (checkCompatibility(snapshot, content).length > 0) return refused("savedCharacterProblem");
          const sheet = instantiateHero(snapshot, record.houseRules);
          seats.push({ userId: member.userId, heroId: sheet.id, sheet });
        }
        let state;
        try {
          state = buildStartingState({ campaignId: key.campaignId, organizerId: record.organizerId, adventure: document, seats, pacing: record.pacing, startingLevel: startingLevelFor(record.houseRules, document.bible.startingLevel) });
        } catch (error) {
          if (error instanceof StartingStateError) return refused("notReady");
          throw error;
        }
        await tx.createCampaign(key, {
          state,
          revision: 0,
          ruleset: { ...this.options.ruleset, houseRules: record.houseRules },
          adventure: record.adventure,
        });
        const next: CampaignRecord = { ...record, lifecycle: "active", lobby: result.lobby, startedAt: this.options.clock.now() };
        await tx.saveRecord(next, stored.revision);
        return ok(next);
      });
      if (started.kind === "refused") return started;
      // The Narrator tells the opening first; the first round opens when it lands.
      this.options.onStarted?.(key);
      const firstRound = await this.options.bus.execute(key, { kind: "beginAdventure" }, { commandId: `start:${key.campaignId}`, actor: { kind: "system" } });
      return ok({ record: started.value, firstRound });
    });
  }

  private change(
    key: CampaignKey,
    apply: (lobby: CampaignRecord["lobby"], record: CampaignRecord) => LobbyResult,
    closesTo?: CampaignRecord["lifecycle"],
  ): Promise<ServiceResult<CampaignRecord>> {
    return this.queue.run(queueKey(key), async () => {
      try {
        return await this.attempt(key, apply, closesTo);
      } catch (error) {
        // The record moved between load and save (another process): decide again once.
        if (!(error instanceof RevisionConflictError)) throw error;
        return this.attempt(key, apply, closesTo);
      }
    });
  }

  private attempt(
    key: CampaignKey,
    apply: (lobby: CampaignRecord["lobby"], record: CampaignRecord) => LobbyResult,
    closesTo?: CampaignRecord["lifecycle"],
  ): Promise<ServiceResult<CampaignRecord>> {
    return this.options.unitOfWork.transaction(async (tx) => {
      const stored = await tx.loadRecord(key);
      if (stored === undefined) return refused("notFound");
      if (stored.record.lifecycle !== "lobby") return refused("notLobby");
      const result = apply(stored.record.lobby, stored.record);
      if (!result.ok) return refused(result.reason);
      if (result.lobby === stored.record.lobby) return ok(stored.record);
      const next: CampaignRecord = { ...stored.record, lobby: result.lobby, ...(closesTo === undefined ? {} : { lifecycle: closesTo }) };
      await tx.saveRecord(next, stored.revision);
      return ok(next);
    });
  }
}

function queueKey(key: CampaignKey): string {
  return `${key.guildId}:${key.campaignId}`;
}

function ok<T>(value: T): ServiceResult<T> {
  return { kind: "ok", value };
}

function refused<T>(reason: ServiceRefusal): ServiceResult<T> {
  return { kind: "refused", reason };
}
