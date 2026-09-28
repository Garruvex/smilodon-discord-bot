import { KeyedSerialQueue } from "../../../application/concurrency/keyed-serial-queue.js";
import type { CampaignIssues } from "../../../application/campaign/campaign-issues.js";
import type { RuntimeLogger } from "../../../application/campaign/campaign-runtime.js";
import type { CampaignRecord, GuildCampaignSettings, PendingResource } from "../../../application/campaign/ports/campaign-record.js";
import { RevisionConflictError, type CampaignKey, type CampaignUnitOfWork } from "../../../application/campaign/ports/campaign-store.js";
import { activeMembers } from "../../../domain/campaign/lobby/lobby.js";
import { resourceMarker } from "../../../application/campaign/setup/channel-names.js";
import { texts } from "../../../application/i18n/texts.js";
import type { CampaignCardService } from "./campaign-card-service.js";
import type { CampaignResourceGateway } from "./campaign-resource-gateway.js";

export type GuildSetupResult =
  | { readonly kind: "ok"; readonly settings: GuildCampaignSettings }
  | { readonly kind: "missingPermissions"; readonly missing: readonly string[] };

export type ProvisionResult =
  | { readonly kind: "ok"; readonly record: CampaignRecord }
  | { readonly kind: "notFound" }
  | { readonly kind: "notSetup" }
  | { readonly kind: "missingPermissions"; readonly missing: readonly string[] }
  | { readonly kind: "failed"; readonly step: PendingResource["kind"] };

export type VisibilityResult =
  | { readonly kind: "open" }
  | { readonly kind: "applied"; readonly roleId: string }
  | { readonly kind: "failed" };

export type RepairResult =
  | { readonly kind: "ok"; readonly requeued: number }
  | { readonly kind: "notFound" }
  | { readonly kind: "archived" }
  | { readonly kind: "notSetup" }
  | { readonly kind: "missingPermissions"; readonly missing: readonly string[] }
  | { readonly kind: "failed"; readonly step: PendingResource["kind"] };

export interface CampaignSetupServiceOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly issues?: CampaignIssues;
  readonly resources: CampaignResourceGateway;
  readonly cards: CampaignCardService;
  readonly logger: RuntimeLogger;
}

const categoryName = "D&D";
const hubChannelName = "dnd-games";
export const adminRoleName = "DnD Admin";
const privateGamesRoleName = "Private Games";
// A campaign post is tagged with its lifecycle in the Games forum; Parties
// posts carry no tags (plan §1's campaign tags, §10 forum access).
const gameStatusTags = ["Recruiting", "Active", "Paused", "Completed"] as const;
const reasonFor = (what: string): string => `D&D campaign: ${what}`;

// Sets up a server for campaigns and creates each game's places on Discord
// (plan §1/§3: paired Games/Parties forums, public and private). Creation is
// resumable: the resources a game needs are written down before any Discord
// call, each ID is saved right after its create, and a retry finds what an
// uncertain create left behind by its marker instead of making a duplicate.
export class CampaignSetupService {
  private readonly queue = new KeyedSerialQueue();

  public constructor(private readonly options: CampaignSetupServiceOptions) {}

  // /dnd setup: check permissions, make (or keep) the D&D category, the four
  // campaign forums (Public/Private Games, Public/Private Parties), and pick
  // the hub channel: the one the organizer ran the command in, or a new
  // read-only "dnd-games" channel.
  public setupGuild(guildId: string, preferredHubChannelId: string | null): Promise<GuildSetupResult> {
    return this.queue.run(`guild:${guildId}`, async () => {
      const { resources, unitOfWork } = this.options;
      const existing = await unitOfWork.transaction((tx) => tx.loadGuildSettings(guildId));
      let categoryId = existing?.categoryId ?? null;
      if (categoryId !== null && !(await resources.categoryExists(guildId, categoryId))) categoryId = null;
      const missing = await resources.missingPermissions(guildId, categoryId);
      if (missing.length > 0) return { kind: "missingPermissions", missing };
      if (categoryId === null) categoryId = await resources.createCategory(guildId, categoryName, reasonFor("category"));

      let hubChannelId = preferredHubChannelId ?? existing?.hubChannelId ?? null;
      if (hubChannelId !== null && !(await resources.channelExists(guildId, hubChannelId))) hubChannelId = null;
      if (hubChannelId === null) {
        hubChannelId = await resources.createTextChannel(
          guildId,
          { name: hubChannelName, topic: "D&D games on this server", parentId: categoryId, playersReadOnly: true, allowThreadMessages: false },
          reasonFor("hub channel"),
        );
      }

      let adminRoleId = existing?.adminRoleId ?? null;
      if (adminRoleId !== null && !(await resources.roleExists(guildId, adminRoleId))) adminRoleId = null;
      adminRoleId ??= await resources.createRole(guildId, adminRoleName, reasonFor("admin role"));

      let privateGamesRoleId = existing?.privateGamesRoleId ?? null;
      if (privateGamesRoleId !== null && !(await resources.roleExists(guildId, privateGamesRoleId))) privateGamesRoleId = null;
      privateGamesRoleId ??= await resources.createRole(guildId, privateGamesRoleName, reasonFor("private games role"));

      const forum = async (currentId: string | null | undefined, name: string, tags: readonly string[], viewerRoleId: string | null): Promise<string> => {
        let id = currentId ?? null;
        if (id !== null && !(await resources.forumExists(guildId, id))) id = null;
        id ??= await resources.createForum(guildId, { name, topic: `D&D ${name.replace(/-/g, " ")}`, parentId: categoryId, tags, viewerRoleId }, reasonFor(`${name} forum`));
        return id;
      };
      const publicGamesForumId = await forum(existing?.publicGamesForumId, "public-games", gameStatusTags, null);
      const publicPartiesForumId = await forum(existing?.publicPartiesForumId, "public-parties", [], null);
      const privateGamesForumId = await forum(existing?.privateGamesForumId, "private-games", gameStatusTags, privateGamesRoleId);
      const privatePartiesForumId = await forum(existing?.privatePartiesForumId, "private-parties", [], privateGamesRoleId);

      const settings: GuildCampaignSettings = {
        guildId,
        categoryId,
        hubChannelId,
        publicGamesForumId,
        publicPartiesForumId,
        privateGamesForumId,
        privatePartiesForumId,
        // A new hub channel needs a new card.
        hubCard: existing?.hubChannelId === hubChannelId ? (existing?.hubCard ?? null) : null,
        adminRoleId,
        privateGamesRoleId,
      };
      await unitOfWork.transaction((tx) => tx.saveGuildSettings(settings));
      await this.options.cards.syncHub(guildId);
      // The hub card's reference was saved by the sync.
      const saved = await unitOfWork.transaction((tx) => tx.loadGuildSettings(guildId));
      return { kind: "ok", settings: saved ?? settings };
    });
  }

  // Creates a game's Games (Adventure) post and its matching Parties post, in
  // whichever forum pair its visibility picks, then draws its cards. Safe to
  // run again after a failure. Visibility is fixed at creation: a forum post
  // cannot be moved to a different forum, so there is no later "make this
  // campaign private" flow yet (documented gap, not attempted here).
  public provision(key: CampaignKey): Promise<ProvisionResult> {
    return this.queue.run(`campaign:${key.guildId}:${key.campaignId}`, async () => {
      const { resources, unitOfWork } = this.options;
      const loaded = await unitOfWork.transaction(async (tx) => ({ stored: await tx.loadRecord(key), settings: await tx.loadGuildSettings(key.guildId) }));
      if (loaded.stored === undefined) return { kind: "notFound" };
      const settings = loaded.settings;
      if (settings?.categoryId == null) return { kind: "notSetup" };
      const missing = await resources.missingPermissions(key.guildId, settings.categoryId);
      if (missing.length > 0) return { kind: "missingPermissions", missing };

      let record = loaded.stored.record;
      const text = texts[record.language];
      const gamesForumId = record.visibility === "membersOnly" ? settings.privateGamesForumId : settings.publicGamesForumId;
      const partiesForumId = record.visibility === "membersOnly" ? settings.privatePartiesForumId : settings.publicPartiesForumId;
      if (gamesForumId == null || partiesForumId == null) return { kind: "notSetup" };

      const marker = (kind: PendingResource["kind"]): string => resourceMarker(key.campaignId, kind);
      if (record.pendingResources.length === 0) {
        const planned: readonly PendingResource[] = [
          { kind: "adventurePost", marker: marker("adventurePost"), name: record.name.slice(0, 100), resourceId: null },
          { kind: "partyPost", marker: marker("partyPost"), name: `${record.name} — ${text.campaign.card.party}`.slice(0, 100), resourceId: null },
        ];
        record = await this.update(key, (current) => ({ ...current, pendingResources: planned }));
      }
      const planned = (kind: PendingResource["kind"]): PendingResource => {
        const found = record.pendingResources.find((resource) => resource.kind === kind);
        if (found === undefined) throw new Error(`Campaign ${key.campaignId} has no planned ${kind}.`);
        return found;
      };

      const steps: { kind: PendingResource["kind"]; forumId: string; current: string | null; content: string }[] = [
        { kind: "adventurePost", forumId: gamesForumId, current: record.channels.adventurePostId, content: record.name },
        { kind: "partyPost", forumId: partiesForumId, current: record.channels.partyPostId, content: `${text.campaign.card.party} · ${record.name}` },
      ];
      for (const step of steps) {
        const current = step.current !== null && (await resources.forumPostExists(step.current)) ? step.current : null;
        if (current !== null) continue;
        try {
          const found = await resources.findForumPostByMarker(step.forumId, marker(step.kind));
          const id = found ?? (await resources.createForumPost({ forumId: step.forumId, name: planned(step.kind).name, content: step.content, marker: marker(step.kind) }, reasonFor(`${step.kind} for ${record.name}`))).postId;
          record = await this.update(key, (latest) => withPost(latest, step.kind, id));
        } catch (error) {
          this.options.logger.error({ err: error, guildId: key.guildId, campaignId: key.campaignId, step: step.kind }, "Campaign resource setup failed");
          return { kind: "failed", step: step.kind };
        }
      }

      if (record.channels.adventurePostId !== null) {
        await resources.setForumPostTag(gamesForumId, record.channels.adventurePostId, gameStatusTag(record.lifecycle), reasonFor("campaign status tag"));
      }

      await this.options.cards.sync(key);
      return { kind: "ok", record };
    });
  }

  // A private campaign's players are granted the guild's one shared
  // private-games role so they can see the Private Games/Parties forums
  // (plan §1: that role, not a per-table one, gates the private forums).
  // Membership in the game, not the role, decides who may act; the role only
  // gives visibility. Safe to run again (Repair does): a player who lacks the
  // role gets it back. A finished game keeps its role so past players can
  // still read the story.
  public applyVisibility(key: CampaignKey): Promise<VisibilityResult> {
    return this.queue.run(`campaign:${key.guildId}:${key.campaignId}`, async () => {
      const { resources, unitOfWork, issues } = this.options;
      const stored = await unitOfWork.transaction((tx) => tx.loadRecord(key));
      if (stored === undefined || stored.record.visibility !== "membersOnly" || stored.record.lifecycle === "lobby") return { kind: "open" };
      let settings = await unitOfWork.transaction((tx) => tx.loadGuildSettings(key.guildId));
      if (settings === undefined) return { kind: "failed" };
      try {
        let roleId = settings.privateGamesRoleId ?? null;
        if (roleId !== null && !(await resources.roleExists(key.guildId, roleId))) roleId = null;
        if (roleId === null) {
          roleId = await resources.createRole(key.guildId, privateGamesRoleName, reasonFor("private games role"));
          settings = { ...settings, privateGamesRoleId: roleId };
          await unitOfWork.transaction((tx) => tx.saveGuildSettings(settings!));
        }
        const players = [...new Set([stored.record.organizerId, ...activeMembers(stored.record.lobby).map((member) => member.userId)])];
        for (const userId of players) await resources.grantRole(key.guildId, roleId, userId);
        return { kind: "applied", roleId };
      } catch (error) {
        this.options.logger.error({ err: error, guildId: key.guildId, campaignId: key.campaignId }, "Campaign visibility could not be applied");
        await issues?.raise(key, "permissions", "role");
        return { kind: "failed" };
      }
    });
  }

  // Repair: makes any missing post again, sends what had been given up on,
  // redraws every card against what Discord really has, and clears the
  // problems that are now fixed. A finished game is left as it is.
  public async repair(key: CampaignKey): Promise<RepairResult> {
    const { issues, unitOfWork, cards } = this.options;
    const stored = await unitOfWork.transaction((tx) => tx.loadRecord(key));
    if (stored === undefined) return { kind: "notFound" };
    if (stored.record.lifecycle === "archived") return { kind: "archived" };
    const provisioned = await this.provision(key);
    switch (provisioned.kind) {
      case "notFound":
      case "notSetup":
        return provisioned;
      case "missingPermissions":
        await issues?.raise(key, "permissions", provisioned.missing.join(", "));
        return provisioned;
      case "failed":
        await issues?.raise(key, "channelMissing", provisioned.step);
        return provisioned;
      case "ok":
        break;
    }
    const requeued = await unitOfWork.transaction((tx) => tx.requeueFailedOutbox(key));
    await issues?.clear(key, ["deliveryFailed", "permissions", "channelMissing"]);
    // A private game's role grant is put right too; a failure there raises
    // the permissions issue again.
    await this.applyVisibility(key);
    // Draws every card again; a card that still cannot be drawn raises its own issue.
    await cards.sync(key, true);
    return { kind: "ok", requeued };
  }

  // Read-modify-write on the record, retrying when another writer moved it.
  private async update(key: CampaignKey, change: (record: CampaignRecord) => CampaignRecord): Promise<CampaignRecord> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.options.unitOfWork.transaction(async (tx) => {
          const stored = await tx.loadRecord(key);
          if (stored === undefined) throw new Error(`Campaign ${key.campaignId} disappeared during setup.`);
          const next = change(stored.record);
          await tx.saveRecord(next, stored.revision);
          return next;
        });
      } catch (error) {
        if (!(error instanceof RevisionConflictError) || attempt >= 3) throw error;
      }
    }
  }
}

// The Games forum's status tag for a campaign's current lifecycle
// (plan §1's campaign tags: Recruiting/Active/Paused/Completed).
function gameStatusTag(lifecycle: CampaignRecord["lifecycle"]): string {
  switch (lifecycle) {
    case "lobby":
      return "Recruiting";
    case "active":
      return "Active";
    case "paused":
      return "Paused";
    case "archived":
      return "Completed";
  }
}

function withPost(record: CampaignRecord, kind: PendingResource["kind"], id: string): CampaignRecord {
  const channels = kind === "partyPost" ? { ...record.channels, partyPostId: id } : { ...record.channels, adventurePostId: id };
  return { ...record, channels, pendingResources: record.pendingResources.map((resource) => (resource.kind === kind ? { ...resource, resourceId: id } : resource)) };
}
