import { KeyedSerialQueue } from "../../../application/concurrency/keyed-serial-queue.js";
import type { CampaignIssues } from "../../../application/campaign/campaign-issues.js";
import type { RuntimeLogger } from "../../../application/campaign/campaign-runtime.js";
import type { CampaignRecord, GuildCampaignSettings, PendingResource } from "../../../application/campaign/ports/campaign-record.js";
import { RevisionConflictError, type CampaignKey, type CampaignUnitOfWork } from "../../../application/campaign/ports/campaign-store.js";
import { activeMembers } from "../../../domain/campaign/lobby/lobby.js";
import { gameChannelNames, resourceMarker } from "../../../application/campaign/setup/channel-names.js";
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
const reasonFor = (what: string): string => `D&D campaign: ${what}`;

// Sets up a server for campaigns and creates each game's places on Discord
// (plan §3, Server setup and Channel creation). Creation is resumable: the
// resources a game needs are written down before any Discord call, each ID is
// saved right after its create, and a retry finds what an uncertain create
// left behind by its marker instead of making a duplicate.
export class CampaignSetupService {
  private readonly queue = new KeyedSerialQueue();

  public constructor(private readonly options: CampaignSetupServiceOptions) {}

  // /dnd setup: check permissions, make (or keep) the D&D category, and pick
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
      const settings: GuildCampaignSettings = {
        guildId,
        categoryId,
        hubChannelId,
        // A new hub channel needs a new card.
        hubCard: existing?.hubChannelId === hubChannelId ? (existing?.hubCard ?? null) : null,
        adminRoleId,
      };
      await unitOfWork.transaction((tx) => tx.saveGuildSettings(settings));
      await this.options.cards.syncHub(guildId);
      // The hub card's reference was saved by the sync.
      const saved = await unitOfWork.transaction((tx) => tx.loadGuildSettings(guildId));
      return { kind: "ok", settings: saved ?? settings };
    });
  }

  // Creates a game's Party and Adventure channels and its Table Talk thread,
  // then draws its cards. Safe to run again after a failure.
  public provision(key: CampaignKey): Promise<ProvisionResult> {
    return this.queue.run(`campaign:${key.guildId}:${key.campaignId}`, async () => {
      const { resources, unitOfWork } = this.options;
      const loaded = await unitOfWork.transaction(async (tx) => ({ stored: await tx.loadRecord(key), settings: await tx.loadGuildSettings(key.guildId) }));
      if (loaded.stored === undefined) return { kind: "notFound" };
      if (loaded.settings?.categoryId === null || loaded.settings === undefined) return { kind: "notSetup" };
      const categoryId = loaded.settings.categoryId;
      const missing = await resources.missingPermissions(key.guildId, categoryId);
      if (missing.length > 0) return { kind: "missingPermissions", missing };

      const marker = (kind: PendingResource["kind"]): string => resourceMarker(key.campaignId, kind);
      let record = loaded.stored.record;
      const text = texts[record.language];
      // Write down what is about to be created, with its names, before creating any of it.
      if (record.pendingResources.length === 0) {
        const names = gameChannelNames(record.name, await resources.channelNames(key.guildId, categoryId));
        const planned: readonly PendingResource[] = [
          { kind: "partyChannel", marker: marker("partyChannel"), name: names.party, resourceId: null },
          { kind: "adventureChannel", marker: marker("adventureChannel"), name: names.adventure, resourceId: null },
          { kind: "discussionThread", marker: marker("discussionThread"), name: `${record.name} — ${text.campaign.card.linkTalk}`, resourceId: null },
        ];
        record = await this.update(key, (current) => ({ ...current, pendingResources: planned }));
      }
      const planned = (kind: PendingResource["kind"]): PendingResource => {
        const found = record.pendingResources.find((resource) => resource.kind === kind);
        if (found === undefined) throw new Error(`Campaign ${key.campaignId} has no planned ${kind}.`);
        return found;
      };
      const steps: { kind: PendingResource["kind"]; current: string | null; create: () => Promise<string>; find: () => Promise<string | null> }[] = [
        {
          kind: "partyChannel",
          current: record.channels.partyChannelId,
          find: () => resources.findTextChannelByMarker(key.guildId, categoryId, marker("partyChannel")),
          create: () =>
            resources.createTextChannel(
              key.guildId,
              { name: planned("partyChannel").name, topic: `${text.campaign.card.party} · ${record.name} · ${marker("partyChannel")}`, parentId: categoryId, playersReadOnly: true, allowThreadMessages: true, viewerRoleId: viewerRole(record) },
              reasonFor(`Party channel for ${record.name}`),
            ),
        },
        {
          kind: "adventureChannel",
          current: record.channels.adventureChannelId,
          find: () => resources.findTextChannelByMarker(key.guildId, categoryId, marker("adventureChannel")),
          create: () =>
            resources.createTextChannel(
              key.guildId,
              { name: planned("adventureChannel").name, topic: `${record.name} · ${marker("adventureChannel")}`, parentId: categoryId, playersReadOnly: true, allowThreadMessages: false, viewerRoleId: viewerRole(record) },
              reasonFor(`Adventure channel for ${record.name}`),
            ),
        },
      ];
      for (const step of steps) {
        const current = step.current !== null && (await resources.channelExists(key.guildId, step.current)) ? step.current : null;
        if (current !== null) continue;
        try {
          const id = (await step.find()) ?? (await step.create());
          record = await this.update(key, (latest) => withChannel(latest, step.kind, id));
        } catch (error) {
          this.options.logger.error({ err: error, guildId: key.guildId, campaignId: key.campaignId, step: step.kind }, "Campaign resource setup failed");
          return { kind: "failed", step: step.kind };
        }
      }

      const partyId = record.channels.partyChannelId;
      if (partyId !== null) {
        const current = record.channels.discussionThreadId;
        if (current === null || !(await resources.threadExists(current))) {
          const threadName = planned("discussionThread").name;
          try {
            const id = (await resources.findThreadByName(partyId, threadName)) ?? (await resources.createDiscussionThread(partyId, threadName, reasonFor("Table Talk thread")));
            record = await this.update(key, (latest) => ({
              ...latest,
              channels: { ...latest.channels, discussionThreadId: id },
              pendingResources: latest.pendingResources.map((resource) => (resource.kind === "discussionThread" ? { ...resource, resourceId: id } : resource)),
            }));
          } catch (error) {
            this.options.logger.error({ err: error, guildId: key.guildId, campaignId: key.campaignId, step: "discussionThread" }, "Campaign resource setup failed");
            return { kind: "failed", step: "discussionThread" };
          }
        }
      }
      await this.options.cards.sync(key);
      return { kind: "ok", record };
    });
  }

  // A players-only game hides its channels when it starts: the game's role is
  // made (once), every player at the table is given it, and both channels are
  // shown to that role alone. Membership in the game, not the role, decides who
  // may act; the role only mirrors it so the channels can be seen. Safe to run
  // again (Repair does): a player who lacks the role gets it back, and a
  // spectator an administrator added by hand is left alone. A finished game
  // keeps its role so past players can still read the story.
  public applyVisibility(key: CampaignKey): Promise<VisibilityResult> {
    return this.queue.run(`campaign:${key.guildId}:${key.campaignId}`, async () => {
      const { resources, unitOfWork, issues } = this.options;
      const stored = await unitOfWork.transaction((tx) => tx.loadRecord(key));
      if (stored === undefined || stored.record.visibility !== "membersOnly" || stored.record.lifecycle === "lobby") return { kind: "open" };
      let record = stored.record;
      try {
        let roleId = record.channels.roleId;
        if (roleId === null || !(await resources.roleExists(key.guildId, roleId))) {
          const name = `🎲 ${record.name}`.slice(0, 100);
          const created = await resources.createRole(key.guildId, name, reasonFor(`role for ${record.name}`));
          roleId = created;
          record = await this.update(key, (latest) => ({
            ...latest,
            channels: { ...latest.channels, roleId: created },
            pendingResources: [...latest.pendingResources.filter((resource) => resource.kind !== "role"), { kind: "role", marker: resourceMarker(key.campaignId, "role"), name, resourceId: created }],
          }));
        }
        const players = [...new Set([record.organizerId, ...activeMembers(record.lobby).map((member) => member.userId)])];
        for (const userId of players) await resources.grantRole(key.guildId, roleId, userId);
        const { partyChannelId, adventureChannelId } = record.channels;
        if (partyChannelId !== null) await resources.restrictToRole(key.guildId, partyChannelId, roleId, true);
        if (adventureChannelId !== null) await resources.restrictToRole(key.guildId, adventureChannelId, roleId, false);
        return { kind: "applied", roleId };
      } catch (error) {
        this.options.logger.error({ err: error, guildId: key.guildId, campaignId: key.campaignId }, "Campaign visibility could not be applied");
        await issues?.raise(key, "permissions", "role");
        return { kind: "failed" };
      }
    });
  }

  // Repair: makes any missing channel or thread again, sends what had been
  // given up on, redraws every card against what Discord really has, and clears
  // the problems that are now fixed. A finished game is left as it is.
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
    // A players-only game's role and channel overwrites are put right too; a
    // failure there raises the permissions issue again.
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

// The role a players-only game's channels are shown to, once it has one.
function viewerRole(record: CampaignRecord): string | null {
  return record.visibility === "membersOnly" && record.lifecycle !== "lobby" ? record.channels.roleId : null;
}

function withChannel(record: CampaignRecord, kind: PendingResource["kind"], id: string): CampaignRecord {
  const channels = kind === "partyChannel" ? { ...record.channels, partyChannelId: id } : { ...record.channels, adventureChannelId: id };
  return { ...record, channels, pendingResources: record.pendingResources.map((resource) => (resource.kind === kind ? { ...resource, resourceId: id } : resource)) };
}
