import type { CampaignLobbyService, ServiceResult } from "../../application/campaign/campaign-lobby-service.js";
import type { CampaignRecord } from "../../application/campaign/ports/campaign-record.js";
import type { CampaignKey, CampaignUnitOfWork } from "../../application/campaign/ports/campaign-store.js";
import type { AdventureSummary } from "../../application/campaign/ports/adventure-library.js";
import type { CampaignGameCreator, NewGame } from "../discord/campaign/campaign-game-creator.js";

export type ActivityTableInput = Omit<NewGame, "guildId" | "organizerId"> & { readonly joinAsPlayer: boolean };
export interface ActivityTableOptions {
  readonly canCreate: boolean;
  readonly creationBlock: "notSetup" | "noModel" | null;
  readonly language: "en" | "zh-TW";
  readonly adventures: readonly AdventureSummary[];
}
export interface ActivityTableManagement {
  readonly campaignId: string;
  readonly name: string;
  readonly lifecycle: CampaignRecord["lifecycle"];
  readonly maxPlayers: number;
  readonly playerCount: number;
  readonly members: readonly { readonly userId: string; readonly displayName?: string; readonly heroName: string | null; readonly ready: boolean }[];
  readonly requests: readonly { readonly userId: string; readonly displayName?: string; readonly status: string; readonly entrance: string | null; readonly expiresAt: number }[];
}
export interface ActivityInviteMember { readonly userId: string; readonly displayName: string }
export type ActivityTableResult<T> = { readonly kind: "ok"; readonly value: T } | { readonly kind: "refused"; readonly reason: string };

// Activity setup uses the same creator and lobby service as Discord. Identity
// and role checks are supplied by the server, not accepted from the client.
export class ActivityTableService {
  public constructor(private readonly options: {
    readonly unitOfWork: CampaignUnitOfWork;
    readonly lobby: CampaignLobbyService;
    readonly creator: Pick<CampaignGameCreator, "create" | "modelConfigured">;
    readonly adventures: { listForGuild(guildId: string): readonly AdventureSummary[] };
    readonly isAdmin: (guildId: string, userId: string) => Promise<boolean>;
    readonly isMember: (guildId: string, userId: string) => Promise<boolean>;
    readonly refresh: (key: CampaignKey) => void;
    readonly now: () => number;
    readonly searchMembers: (guildId: string, query: string) => Promise<readonly ActivityInviteMember[]>;
    readonly memberName: (guildId: string, userId: string) => Promise<string>;
  }) {}

  public async catalog(guildId: string, userId: string): Promise<ActivityTableOptions> {
    const canCreate = await this.options.isAdmin(guildId, userId);
    const settings = await this.options.unitOfWork.transaction((tx) => tx.loadGuildSettings(guildId));
    return {
      canCreate,
      creationBlock: settings?.categoryId == null || settings.hubChannelId == null ? "notSetup" : !this.options.creator.modelConfigured ? "noModel" : null,
      language: settings?.language ?? "en",
      adventures: canCreate ? this.options.adventures.listForGuild(guildId) : [],
    };
  }

  public async create(guildId: string, userId: string, input: ActivityTableInput): Promise<ActivityTableResult<{ readonly campaignId: string; readonly warning: string | null }>> {
    const catalog = await this.catalog(guildId, userId);
    if (!catalog.canCreate) return { kind: "refused", reason: "notOrganizer" };
    if (catalog.creationBlock !== null) return { kind: "refused", reason: catalog.creationBlock };
    const { joinAsPlayer, ...game } = input;
    const result = await this.options.creator.create({ ...game, guildId, organizerId: userId });
    // A failed provisioning step retains a recoverable campaign. Return its
    // identity so retrying in the UI does not accidentally create another one.
    const record = result.kind === "created" ? result.record : result.kind !== "refused" && result.kind !== "noModel"
      ? (await this.options.lobby.list(guildId)).find(({ record }) => record.name.toLowerCase() === game.name.trim().toLowerCase() && record.organizerId === userId)?.record
      : undefined;
    if (record === undefined) return { kind: "refused", reason: result.kind === "refused" ? result.reason : result.kind };
    if (joinAsPlayer) {
      const joined = await this.options.lobby.joinFromActivity(record.key, userId);
      if (joined.kind === "refused") return { kind: "ok", value: { campaignId: record.key.campaignId, warning: joined.reason } };
    }
    this.options.refresh(record.key);
    return { kind: "ok", value: { campaignId: record.key.campaignId, warning: result.kind !== "created" ? "provisioningFailed" : null } };
  }

  public async membersForInvite(key: CampaignKey, actorId: string, query: string): Promise<ActivityTableResult<readonly ActivityInviteMember[]>> {
    const management = await this.management(key, actorId);
    if (management.kind === "refused") return management;
    const seated = new Set(management.value.members.map((member) => member.userId));
    const members = await this.options.searchMembers(key.guildId, query);
    return { kind: "ok", value: members.filter((member) => !seated.has(member.userId)) };
  }

  public async management(key: CampaignKey, userId: string): Promise<ActivityTableResult<ActivityTableManagement>> {
    const result = await this.options.unitOfWork.transaction(async (tx): Promise<ActivityTableResult<ActivityTableManagement>> => {
      const stored = await tx.loadRecord(key);
      if (stored === undefined) return { kind: "refused", reason: "notFound" };
      const { record } = stored;
      if (record.organizerId !== userId) return { kind: "refused", reason: "notOrganizer" };
      if (record.lifecycle === "archived") return { kind: "refused", reason: "closed" };
      const campaign = await tx.loadCampaign(key);
      const members = record.lobby.members.filter((member) => member.status !== "withdrawn");
      return { kind: "ok", value: {
        campaignId: key.campaignId, name: record.name, lifecycle: record.lifecycle, maxPlayers: record.lobby.maxPlayers,
        playerCount: campaign === undefined ? members.length : Object.keys(campaign.state.members).length,
        members: members.map((member) => ({ userId: member.userId, heroName: member.label?.name ?? (member.heroId === null ? null : campaign?.state.characters[member.heroId]?.name ?? null), ready: member.status === "ready" })),
        requests: Object.entries(record.joinRequests ?? {}).filter(([, request]) => request.expiresAt > this.options.now()).map(([userId, request]) => ({ userId, status: request.status, entrance: request.entrance ?? null, expiresAt: request.expiresAt })),
      } };
    });
    if (result.kind === "refused") return result;
    const names = new Map(await Promise.all([...new Set([...result.value.members, ...result.value.requests].map((member) => member.userId))].map(async (id): Promise<readonly [string, string]> => [id, await this.options.memberName(key.guildId, id)])));
    return { kind: "ok", value: { ...result.value, members: result.value.members.map((member) => ({ ...member, displayName: names.get(member.userId) ?? member.userId })), requests: result.value.requests.map((request) => ({ ...request, displayName: names.get(request.userId) ?? request.userId })) } };
  }

  public async invite(key: CampaignKey, actorId: string, userId: string, entrance: string): Promise<ServiceResult<CampaignRecord>> {
    const stored = await this.options.lobby.get(key);
    if (stored === undefined) return { kind: "refused", reason: "notFound" };
    if (stored.record.organizerId !== actorId) return { kind: "refused", reason: "notOrganizer" };
    if (!await this.options.isMember(key.guildId, userId)) return { kind: "refused", reason: "notMember" };
    const result = stored.record.lifecycle === "lobby"
      ? await this.options.lobby.inviteLobby(key, actorId, userId)
      : await this.options.lobby.inviteOngoing(key, actorId, userId, entrance);
    if (result.kind === "ok") this.options.refresh(key);
    return result;
  }

  public async decide(key: CampaignKey, actorId: string, userId: string, approve: boolean, entrance: string): Promise<ServiceResult<CampaignRecord>> {
    const result = await this.options.lobby.decideOngoingJoin(key, actorId, userId, approve, entrance);
    if (result.kind === "ok") this.options.refresh(key);
    return result;
  }

  public async resize(key: CampaignKey, actorId: string, maxPlayers: number): Promise<ServiceResult<CampaignRecord>> {
    const result = await this.options.lobby.setPartySize(key, actorId, maxPlayers);
    if (result.kind === "ok") this.options.refresh(key);
    return result;
  }

  public async remove(key: CampaignKey, actorId: string, userId: string): Promise<ServiceResult<CampaignRecord>> {
    const result = await this.options.lobby.removeMember(key, actorId, userId);
    if (result.kind === "ok") this.options.refresh(key);
    return result;
  }
}
