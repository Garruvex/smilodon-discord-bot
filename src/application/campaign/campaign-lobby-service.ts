import { randomUUID } from "node:crypto";

import type { CampaignLanguage } from "../../domain/campaign/adventure/adventure-bible.js";
import type { UserId } from "../../domain/campaign/core/ids.js";
import * as lobbyRules from "../../domain/campaign/lobby/lobby.js";
import type { LobbyRefusal, LobbyResult } from "../../domain/campaign/lobby/lobby.js";
import { HouseRuleError, resolveHouseRules } from "../../domain/campaign/rules/house-rules.js";
import { KeyedSerialQueue } from "../concurrency/keyed-serial-queue.js";
import type { CampaignCommandBus } from "./campaign-command-bus.js";
import { emptyChannels, type CampaignRecord, type StoredRecord } from "./ports/campaign-record.js";
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
import { buildStartingState, StartingStateError } from "./setup/starting-state.js";

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
}

export type ServiceRefusal =
  | LobbyRefusal
  | "notFound"
  | "notLobby"
  | "unknownAdventure"
  | "languageUnavailable"
  | "invalidName"
  | "nameTaken"
  | "invalidPacing"
  | "invalidHouseRules";

export type ServiceResult<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "refused"; readonly reason: ServiceRefusal };

export interface CampaignLobbyServiceOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly bus: CampaignCommandBus;
  readonly adventures: AdventureLibrary;
  readonly clock: Clock;
  // The ruleset new campaigns are pinned to, with its default house rules.
  readonly ruleset: RulesetPin;
  readonly newId?: () => string;
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
    if (lobby.lobby.maxPlayers > document.heroes.length) return refused("invalidLimits");

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

  // The campaign a message channel belongs to: its Party or Adventure channel,
  // or the Table Talk thread (pass the thread and its parent channel).
  public async findByChannel(guildId: string, channelIds: readonly string[]): Promise<StoredRecord | undefined> {
    const all = await this.list(guildId);
    return all.find(({ record }) => {
      const { partyChannelId, adventureChannelId, discussionThreadId } = record.channels;
      return [partyChannelId, adventureChannelId, discussionThreadId].some((id) => id !== null && channelIds.includes(id));
    });
  }

  public list(guildId: string): Promise<readonly StoredRecord[]> {
    return this.options.unitOfWork.transaction((tx) => tx.listRecords(guildId));
  }

  public join(key: CampaignKey, userId: UserId): Promise<ServiceResult<CampaignRecord>> {
    return this.change(key, (lobby) => lobbyRules.join(lobby, userId));
  }

  public leave(key: CampaignKey, userId: UserId): Promise<ServiceResult<CampaignRecord>> {
    return this.change(key, (lobby) => lobbyRules.leave(lobby, userId));
  }

  public removeMember(key: CampaignKey, actorId: UserId, userId: UserId): Promise<ServiceResult<CampaignRecord>> {
    return this.change(key, (lobby, record) => lobbyRules.remove(lobby, actorId, record.organizerId, userId));
  }

  public chooseHero(key: CampaignKey, userId: UserId, heroId: string): Promise<ServiceResult<CampaignRecord>> {
    return this.change(key, (lobby, record) => {
      const heroes = this.options.adventures.document(record.adventure.adventureId, record.language)?.heroes ?? [];
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
      return ended;
    });
  }

  // Starts play: the engine campaign is created from the lobby's seats and the
  // record moves to active in one transaction, then the first round opens. If
  // the process stops between the two, the campaign is active with no round
  // yet, and the startup recovery opens it (the round command is idempotent).
  public start(key: CampaignKey, actorId: UserId): Promise<ServiceResult<{ readonly record: CampaignRecord; readonly firstRound: CommandOutcome }>> {
    return this.queue.run(queueKey(key), async () => {
      const started = await this.options.unitOfWork.transaction(async (tx): Promise<ServiceResult<CampaignRecord>> => {
        const stored = await tx.loadRecord(key);
        if (stored === undefined) return refused("notFound");
        const { record } = stored;
        if (record.lifecycle !== "lobby") return refused("notLobby");
        const result = lobbyRules.start(record.lobby, actorId, record.organizerId);
        if (!result.ok) return refused(result.reason);
        const document = this.options.adventures.document(record.adventure.adventureId, record.language);
        if (document === undefined) return refused("unknownAdventure");
        const seats = lobbyRules.activeMembers(result.lobby).flatMap((member) => (member.heroId === null ? [] : [{ userId: member.userId, heroId: member.heroId }]));
        let state;
        try {
          state = buildStartingState({ campaignId: key.campaignId, organizerId: record.organizerId, adventure: document, seats, pacing: record.pacing });
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
      const firstRound = await this.options.bus.execute(key, { kind: "openRound" }, { commandId: `start:${key.campaignId}`, actor: { kind: "system" } });
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
