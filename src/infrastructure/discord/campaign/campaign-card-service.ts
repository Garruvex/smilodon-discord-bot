import { createHash } from "node:crypto";

import { KeyedSerialQueue } from "../../../application/concurrency/keyed-serial-queue.js";
import type { AdventureLibrary } from "../../../application/campaign/ports/adventure-library.js";
import type { CardRefresher } from "../../../application/campaign/ports/card-refresher.js";
import { DiscordAPIError, RESTJSONErrorCodes } from "discord.js";

import type { CampaignIssues } from "../../../application/campaign/campaign-issues.js";
import type { CampaignIssueCode, CampaignRecord, CardReference } from "../../../application/campaign/ports/campaign-record.js";
import { RevisionConflictError, type CampaignKey, type CampaignUnitOfWork, type StoredCampaign } from "../../../application/campaign/ports/campaign-store.js";
import type { RuntimeLogger } from "../../../application/campaign/campaign-runtime.js";
import type { RulesetCatalog } from "../../../application/campaign/rules/ruleset-catalog.js";
import type { CampaignResourceGateway } from "./campaign-resource-gateway.js";
import { gameStatusTag } from "./campaign-setup-service.js";
import {
  buildLobbyView,
  type PanelView,
  buildOfferViews,
  buildOpportunityAttackView,
  buildPanelView,
  buildPartyView,
  buildReactionView,
  buildSmiteView,
} from "../../../application/campaign/views/campaign-views.js";
import type { Language } from "../../../application/i18n/language.js";
import { texts as allTexts } from "../../../application/i18n/texts.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import { renderAdventurePanel } from "./adventure-panel.js";
import { renderCampaignCard } from "./campaign-card.js";
import type { CampaignMessageGateway } from "./campaign-message-gateway.js";
import type { CardPayload } from "./card-payload.js";
import { renderHeroCard } from "./hero-card.js";
import type { HeroPictureFile, HeroPictures } from "./hero-pictures.js";
import { renderHubControl, renderHubGame, type HubGame } from "./hub-card.js";
import { renderLobbyCard } from "./lobby-card.js";
import { renderOfferCard } from "./offer-card.js";
import { renderOpportunityAttackCard } from "./opportunity-attack-card.js";
import { renderReactionCard } from "./reaction-card.js";
import { renderSmiteCard } from "./smite-card.js";

export interface CampaignCardServiceOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly rulesets: RulesetCatalog;
  readonly adventures: AdventureLibrary;
  readonly messages: CampaignMessageGateway;
  readonly glossaries: Readonly<Record<string, Glossary>>;
  readonly logger: RuntimeLogger;
  // Where a card that cannot be drawn is reported for the organizer.
  readonly issues?: CampaignIssues;
  // Milliseconds now; tests move it.
  readonly now?: () => number;
  // Re-tags a campaign's Games post on every sync when given; omitted in
  // tests that don't care about forum tags.
  readonly resources?: CampaignResourceGateway;
  // Hero thumbnails for the party channel's hero cards; omitted in tests that don't draw them.
  readonly pictures?: HeroPictures;
  // Waits (milliseconds) before each retry of a card that could not be drawn for a reason that may pass (a rate limit, a timeout); tests shorten it.
  readonly retryDelaysMs?: readonly number[];
}

// A card that failed to draw is left alone for this long, so a missing
// permission does not become a failing call on every click (Repair ignores it).
const failureCooldownMs = 30_000;

interface CardFailure {
  readonly card: string;
  // "cooling": skipped because it failed a moment ago; it is still broken.
  readonly code: CampaignIssueCode | "cooling";
  readonly detail: string;
}

interface DesiredCard {
  readonly key: string;
  readonly channelId: string;
  readonly payload: CardPayload;
  readonly epoch: string;
  readonly pin: boolean;
}

// Keeps a campaign's cards on Discord in line with its saved state (panel
// spec, Update, replacement, and restart contract). Every path (a click, a
// delivery, startup, Repair) comes through sync(): render what should be
// shown, skip what is unchanged, edit what changed, and replace a card that
// was deleted or whose round or turn moved on. It reads saved state only, so
// running it twice draws the same thing.
// How many times a card that will not draw is tried again on its own before it waits for the next click or the minute pass.
const maxRetries = 20;

export class CampaignCardService implements CardRefresher {
  private readonly queue = new KeyedSerialQueue();
  private readonly scheduled = new Set<string>();
  private readonly appliedTags = new Map<string, string>();
  private verificationCursor = 0;

  public constructor(private readonly options: CampaignCardServiceOptions) {}

  // Coalesced and in the background: requests that arrive while one is queued
  // share it, and a failure is logged, never thrown at the game.
  public refresh(key: CampaignKey): void {
    const id = `${key.guildId}:${key.campaignId}`;
    if (this.scheduled.has(id)) return;
    this.scheduled.add(id);
    void this.queue.run(id, async () => {
      // Combine the roll request, result, and ensuing state changes into one
      // rendering of the latest state instead of several rapid message edits.
      await new Promise((resolve) => setTimeout(resolve, 150));
      this.scheduled.delete(id);
      try {
        await this.syncNow(key);
      } catch (error) {
        this.options.logger.error({ err: error, guildId: key.guildId, campaignId: key.campaignId }, "Campaign card refresh failed");
      }
    });
  }

  // Draws the cards now and waits: used when order matters (narration first,
  // then the next panel), by Repair, and at startup. `verify` also checks that
  // each unchanged card still exists on Discord and draws it again if not.
  public sync(key: CampaignKey, verify = false): Promise<void> {
    return this.queue.run(`${key.guildId}:${key.campaignId}`, () => this.syncNow(key, verify));
  }

  // After a restart: every server's hub and every unfinished game's cards are
  // checked against Discord, so anything deleted while the bot was away comes back.
  public async recoverAll(): Promise<void> {
    const { settings, records } = await this.options.unitOfWork.transaction(async (tx) => ({
      settings: await tx.listGuildSettings(),
      records: await tx.listRecordsByLifecycle(["lobby", "active", "paused"]),
    }));
    for (const { record } of records) {
      try {
        await this.sync(record.key, true);
      } catch (error) {
        this.options.logger.error({ err: error, guildId: record.key.guildId, campaignId: record.key.campaignId }, "Campaign card recovery failed");
      }
    }
    for (const guild of settings) {
      try {
        await this.syncHub(guild.guildId, true);
      } catch (error) {
        this.options.logger.error({ err: error, guildId: guild.guildId }, "Campaign hub recovery failed");
      }
    }
  }

  // State is authoritative. A periodic pass catches a refresh lost during a
  // Discord outage or process restart without rewriting unchanged messages.
  public async reconcileAll(): Promise<void> {
    const { records, settings } = await this.options.unitOfWork.transaction(async (tx) => ({
      records: await tx.listRecordsByLifecycle(["lobby", "active", "paused"]),
      settings: await tx.listGuildSettings(),
    }));
    const guilds = new Set(settings.map((setting) => setting.guildId));
    const verifiedRecord = records.length === 0 ? -1 : this.verificationCursor % records.length;
    for (const [index, { record }] of records.entries()) {
      guilds.add(record.key.guildId);
      try {
        await this.queue.run(`${record.key.guildId}:${record.key.campaignId}`, () => this.syncNow(record.key, index === verifiedRecord, true));
      } catch (error) {
        this.options.logger.error({ err: error, guildId: record.key.guildId, campaignId: record.key.campaignId }, "Campaign card reconciliation failed");
      }
    }
    const guildIds = [...guilds];
    for (const [index, guildId] of guildIds.entries()) {
      try {
        await this.syncHub(guildId, index === this.verificationCursor % guildIds.length);
      } catch (error) {
        this.options.logger.error({ err: error, guildId }, "Campaign hub reconciliation failed");
      }
    }
    this.verificationCursor += 1;
  }

  // Someone deleted messages in a channel. When one of them was a card or the
  // hub, forget its reference (the message is gone, so an unchanged card would
  // otherwise never be redrawn) and draw it again. The bot's own removals of
  // retired messages are ignored.
  public async handleMessagesDeleted(guildId: string, channelId: string, messageIds: readonly string[]): Promise<void> {
    const gone = new Set(messageIds.filter((id) => !this.takeExpectedRemoval(id)));
    if (gone.size === 0) return;
    const { settings, games } = await this.options.unitOfWork.transaction(async (tx) => ({ settings: await tx.loadGuildSettings(guildId), games: await tx.listRecords(guildId) }));
    const hubCard = settings?.hubCard ?? null;
    const hubLost = hubCard !== null && hubCard.channelId === channelId && gone.has(hubCard.messageId);
    if (hubLost) {
      await this.options.unitOfWork.transaction(async (tx) => {
        const latest = await tx.loadGuildSettings(guildId);
        if (latest !== undefined) await tx.saveGuildSettings({ ...latest, hubCard: null });
      });
    }
    let hubTouched = hubLost;
    for (const { record } of games) {
      const lost = Object.entries(record.cards)
        .filter(([, card]) => card.channelId === channelId && gone.has(card.messageId))
        .map(([name]) => name);
      if (lost.length === 0) continue;
      await this.saveReferences(record.key, {}, lost);
      if (lost.includes("hub")) hubTouched = true;
      if (lost.some((name) => name !== "hub")) this.refresh(record.key);
    }
    // A lost hub message redraws the control first so the games stay below it.
    if (hubTouched) {
      try {
        await this.syncHub(guildId);
      } catch (error) {
        this.options.logger.error({ err: error, guildId }, "Campaign hub redraw failed");
      }
    }
  }

  // The campaign's record and what its adventure panel would show now.
  public async describe(key: CampaignKey): Promise<{ readonly record: CampaignRecord; readonly panel: PanelView | null } | undefined> {
    const loaded = await this.options.unitOfWork.transaction(async (tx) => ({ stored: await tx.loadRecord(key), campaign: await tx.loadCampaign(key) }));
    if (loaded.stored === undefined) return undefined;
    const { record } = loaded.stored;
    const bible = this.options.adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
    const glossary = this.options.glossaries[record.language];
    if (loaded.campaign === undefined || bible === undefined || glossary === undefined) return { record, panel: null };
    return { record, panel: buildPanelView(record, loaded.campaign.state, bible, glossary) };
  }

  // True when this message is the campaign's current message for the card, so
  // a control on any other (obsolete) message is refused.
  public static isCurrent(record: CampaignRecord, cardKey: string, messageId: string): boolean {
    return record.cards[cardKey]?.messageId === messageId;
  }

  private async syncNow(key: CampaignKey, verify = false, deferHub = false): Promise<void> {
    const loaded = await this.options.unitOfWork.transaction(async (tx) => ({ stored: await tx.loadRecord(key), campaign: await tx.loadCampaign(key) }));
    if (loaded.stored === undefined) return;
    const { record } = loaded.stored;
    const desired = this.desiredCards(record, loaded.campaign, await this.thumbnails(loaded.campaign));
    const updates: Record<string, CardReference> = {};
    const failures: CardFailure[] = [];
    // A lobby card becomes the campaign card in place when the adventure starts.
    const inherited = record.cards.party === undefined && record.cards.lobby !== undefined ? { party: record.cards.lobby } : {};
    const existing: Readonly<Record<string, CardReference>> = { ...record.cards, ...inherited };
    const channels = new Map<string, DesiredCard[]>();
    for (const card of desired) channels.set(card.channelId, [...(channels.get(card.channelId) ?? []), card]);
    // A slow party-channel edit must not hold the adventure's roll prompt behind it.
    // Within each channel, actionable controls go first and requests remain serial.
    await Promise.all([...channels.values()].map(async (cards) => {
      cards.sort((a, b) => Number(b.key === "adventure") - Number(a.key === "adventure"));
      for (const card of cards) {
        const reference = await this.place(card, existing[card.key], verify, `${key.guildId}:${key.campaignId}:${card.key}`, failures);
        const saved = record.cards[card.key];
        if (reference !== null && (saved === undefined || saved.messageId !== reference.messageId || saved.channelId !== reference.channelId || saved.renderedHash !== reference.renderedHash || saved.epoch !== reference.epoch)) {
          updates[card.key] = reference;
          // Publish the new message identity immediately, so its buttons work
          // even while another channel is waiting on Discord.
          await this.saveReferences(key, { [card.key]: reference }, []);
        }
      }
    }));
    // An offer that was answered leaves the Party channel; an answered reaction, smite, or opportunity attack leaves the Adventure channel.
    const answered = Object.keys(record.cards).filter(
      (name) => (name.startsWith("offer:") || name === "reaction" || name === "smite" || name === "opportunity") && !desired.some((card) => card.key === name),
    );
    for (const name of answered) {
      const card = record.cards[name];
      if (card === undefined) continue;
      this.expectRemoval(card.messageId);
      await this.options.messages.remove(card.channelId, card.messageId).catch(() => undefined);
    }
    await this.saveReferences(key, updates, [...(record.lifecycle !== "lobby" && record.cards.lobby !== undefined ? ["lobby"] : []), ...answered]);
    await this.reportFailures(key, record, failures);
    this.retryTransient(key, failures.some((failure) => failure.code === "cardsFailed" || failure.code === "cooling"));
    await this.syncStatusTag(record, loaded.campaign, verify && !deferHub);
    if (!deferHub) await this.syncHub(key.guildId, verify);
  }

  // Keeps the Games post's status tag (Recruiting/Active/Paused/Completed)
  // in line with the record's lifecycle, plus the one case that isn't its own
  // lifecycle value: a pause lives in the engine state's pausedBy, not on the
  // record. Avoid repeating the same PATCH on every card refresh; a repair or
  // restart verifies the tag again.
  private async syncStatusTag(record: CampaignRecord, campaign: StoredCampaign | undefined, verify = false): Promise<void> {
    const { resources, unitOfWork, logger } = this.options;
    if (resources === undefined) return;
    const postId = record.channels.adventurePostId;
    if (postId === null) return;
    const settings = await unitOfWork.transaction((tx) => tx.loadGuildSettings(record.key.guildId));
    const forumId = record.visibility === "membersOnly" ? settings?.privateGamesForumId : settings?.publicGamesForumId;
    if (forumId == null) return;
    const paused = record.lifecycle === "active" && campaign?.state.pausedBy != null;
    const tag = paused ? "Paused" : gameStatusTag(record.lifecycle);
    if (!verify && this.appliedTags.get(postId) === tag) return;
    try {
      await resources.setForumPostTag(forumId, postId, tag, "D&D campaign: status tag");
      this.appliedTags.set(postId, tag);
    } catch (error) {
      logger.error({ err: error, guildId: record.key.guildId, campaignId: record.key.campaignId }, "Campaign status tag could not be set");
    }
  }

  // Redraws the hub: the pinned control message first, then one message per
  // unfinished game in creation order. Also called when settings change. One
  // redraw per server at a time, since every game's sync ends here.
  public syncHub(guildId: string, verify = false): Promise<void> {
    return this.queue.run(`hub:${guildId}`, () => this.syncHubNow(guildId, verify));
  }

  private async syncHubNow(guildId: string, verify: boolean): Promise<void> {
    const { settings, games, paused } = await this.options.unitOfWork.transaction(async (tx) => {
      const records = await tx.listRecords(guildId);
      // A pause lives in the engine state, not on the record.
      const pausedIds = new Set<string>();
      for (const { record } of records) {
        if (record.lifecycle !== "active" && record.lifecycle !== "paused") continue;
        if ((await tx.loadCampaign(record.key))?.state.pausedBy != null) pausedIds.add(record.key.campaignId);
      }
      return { settings: await tx.loadGuildSettings(guildId), games: records, paused: pausedIds };
    });
    if (settings?.hubChannelId === null || settings === undefined) return;
    const hubChannelId = settings.hubChannelId;
    const live = games.filter(({ record }) => record.lifecycle !== "archived");
    const language: Language = settings.language ?? "en";
    const control = await this.place(
      { key: "hub", channelId: hubChannelId, payload: renderHubControl(live.length, allTexts[language]), epoch: "hub", pin: true },
      settings.hubCard ?? undefined,
      verify,
    );
    if (control === null) return;
    if (control.messageId !== settings.hubCard?.messageId || control.renderedHash !== settings.hubCard.renderedHash) {
      await this.options.unitOfWork.transaction(async (tx) => {
        const latest = await tx.loadGuildSettings(guildId);
        if (latest !== undefined) await tx.saveGuildSettings({ ...latest, hubCard: control });
      });
    }
    // A new control message means the games are drawn again below it, in order.
    const epoch = `hub:${control.messageId}`;
    for (const { record } of games) {
      const existing = record.cards.hub;
      if (record.lifecycle === "archived") {
        if (existing !== undefined) {
          this.expectRemoval(existing.messageId);
          await this.options.messages.remove(existing.channelId, existing.messageId).catch(() => undefined);
          await this.saveReferences(record.key, {}, ["hub"]);
        }
        continue;
      }
      const game: HubGame = {
        campaignId: record.key.campaignId,
        name: record.name,
        lifecycle: paused.has(record.key.campaignId) ? "paused" : record.lifecycle,
        players: record.lobby.members.filter((member) => member.status !== "withdrawn").length,
        maxPlayers: record.lobby.maxPlayers,
        partyChannelId: record.channels.partyPostId,
        adventureChannelId: record.channels.adventurePostId,
      };
      const reference = await this.place(
        { key: `hub:${record.key.campaignId}`, channelId: hubChannelId, payload: renderHubGame(game, allTexts[record.language]), epoch, pin: false },
        existing,
        verify,
      );
      if (reference !== null && (existing === undefined || reference.messageId !== existing.messageId || reference.renderedHash !== existing.renderedHash)) {
        await this.saveReferences(record.key, { hub: reference }, []);
      }
    }
  }

  // Each hero's thumbnail, by character; empty when thumbnails are not wired or a picture cannot be made.
  private async thumbnails(campaign: StoredCampaign | undefined): Promise<ReadonlyMap<string, HeroPictureFile>> {
    const { pictures } = this.options;
    const made = new Map<string, HeroPictureFile>();
    if (pictures === undefined || campaign === undefined) return made;
    for (const sheet of Object.values(campaign.state.characters)) {
      try {
        made.set(sheet.id, await pictures.thumbnail({ characterId: sheet.id, name: sheet.name, ...(sheet.origin === undefined ? {} : { libraryCharacterId: sheet.origin.libraryCharacterId }) }));
      } catch (error) {
        this.options.logger.warn({ err: error, characterId: sheet.id }, "A hero thumbnail could not be made");
      }
    }
    return made;
  }

  private desiredCards(record: CampaignRecord, campaign: StoredCampaign | undefined, thumbnails: ReadonlyMap<string, HeroPictureFile> = new Map()): readonly DesiredCard[] {
    const language: Language = record.language;
    const text = allTexts[language];
    const campaignId = record.key.campaignId;
    const { partyPostId: partyChannelId, adventurePostId: adventureChannelId } = record.channels;
    const cards: DesiredCard[] = [];

    if (record.lifecycle === "lobby" || campaign === undefined) {
      if (partyChannelId !== null) {
        const document = this.options.adventures.documentAt(record.adventure.adventureId, record.adventure.version, record.language);
        const view = buildLobbyView(record, document?.bible.title ?? record.name, document?.heroes.map((hero) => ({ id: hero.id, name: hero.name, className: hero.class })) ?? []);
        cards.push({ key: "lobby", channelId: partyChannelId, payload: renderLobbyCard(view, text, campaignId), epoch: "party", pin: true });
      }
      return cards;
    }

    const bible = this.options.adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
    if (bible === undefined) return cards;
    const glossary = this.options.glossaries[record.language];
    if (glossary === undefined) return cards;
    const content = this.options.rulesets.resolve(campaign.ruleset).content;
    const state = campaign.state;
    const panel = buildPanelView(record, state, bible, glossary);
    const heroes = buildPartyView(state, content);
    const guildUrl = (channelId: string | null): string | null => (channelId === null ? null : `https://discord.com/channels/${record.key.guildId}/${channelId}`);

    if (partyChannelId !== null) {
      cards.push({
        key: "party",
        channelId: partyChannelId,
        payload: renderCampaignCard(
          {
            campaignName: record.name,
            sceneTitle: panel.sceneTitle,
            ...(panel.world === undefined ? {} : { world: panel.world }),
            mode: panel.mode,
            language: record.language,
            pacingPreset: record.pacingPreset,
            organizerId: record.organizerId,
            heroes,
            adventureUrl: guildUrl(adventureChannelId),
          },
          text,
          campaignId,
        ),
        epoch: "party",
        pin: true,
      });
      for (const hero of heroes) {
        cards.push({
          key: `hero:${hero.characterId}`,
          channelId: partyChannelId,
          payload: renderHeroCard(hero, text, campaignId, (id) => glossary.names[id] ?? id, thumbnails.get(hero.characterId)),
          epoch: "hero",
          pin: false,
        });
      }
    }
    if (partyChannelId !== null) {
      for (const offer of buildOfferViews(state)) {
        cards.push({ key: offer.id, channelId: partyChannelId, payload: renderOfferCard(offer, text, campaignId, (id) => glossary.names[id] ?? id), epoch: "offer", pin: false });
      }
    }
    if (adventureChannelId !== null) {
      const reaction = buildReactionView(state, bible, glossary);
      if (reaction !== null) cards.push({ key: "reaction", channelId: adventureChannelId, payload: renderReactionCard(reaction, text, campaignId), epoch: "reaction", pin: false });
      const smite = buildSmiteView(state, bible, glossary);
      if (smite !== null) cards.push({ key: "smite", channelId: adventureChannelId, payload: renderSmiteCard(smite, text, campaignId), epoch: "smite", pin: false });
      const opportunity = buildOpportunityAttackView(state, bible, glossary);
      if (opportunity !== null) {
        cards.push({ key: "opportunity", channelId: adventureChannelId, payload: renderOpportunityAttackCard(opportunity, text, campaignId), epoch: "opportunity", pin: false });
      }
      cards.push({ key: "adventure", channelId: adventureChannelId, payload: renderAdventurePanel(panel, text, campaignId), epoch: panelEpoch(state), pin: false });
    }
    return cards;
  }

  // A game whose cards cannot be drawn is the organizer's to fix (missing
  // permission, deleted channel), so it is written on the record once; a sync
  // that draws everything clears it. A finished game raises nothing.
  private async reportFailures(key: CampaignKey, record: CampaignRecord, failures: readonly CardFailure[]): Promise<void> {
    const { issues } = this.options;
    if (issues === undefined) return;
    try {
      if (failures.length === 0) {
        if ((record.issues ?? []).some((issue) => issue.code !== "deliveryFailed")) await issues.clear(key, ["cardsFailed", "permissions", "channelMissing"]);
        return;
      }
      if (record.lifecycle === "archived") return;
      for (const code of ["permissions", "channelMissing", "cardsFailed"] as const) {
        const matching = failures.filter((failure) => failure.code === code);
        if (matching.length > 0) await issues.raise(key, code, [...new Set(matching.map((failure) => failure.detail))].join(", "));
      }
    } catch (error) {
      this.options.logger.error({ err: error, guildId: key.guildId, campaignId: key.campaignId }, "Campaign issue report failed");
    }
  }

  // Edits the card in place when it is unchanged in identity, replaces it when
  // the message is gone or the round/turn moved on. Returns the reference to
  // save, or null when nothing could be drawn (the failure is logged and the
  // next sync tries again).
  private async place(card: DesiredCard, current: CardReference | undefined, verify = false, failureKey?: string, failures?: CardFailure[]): Promise<CardReference | null> {
    const hash = hashOf(card.payload);
    const { messages } = this.options;
    if (failureKey !== undefined && !verify) {
      const failedAt = this.failedAt.get(failureKey);
      // Only a failure the organizer must fix (permissions, a deleted channel) is left alone for a while; a rate limit or a timeout is tried again at once.
      if (failedAt !== undefined && failedAt.code !== "cardsFailed" && this.now() - failedAt.at < failureCooldownMs) {
        failures?.push({ card: card.key, code: "cooling", detail: failedAt.detail });
        return null;
      }
    }
    try {
      if (current !== undefined && current.channelId === card.channelId) {
        if (current.epoch === card.epoch) {
          if (current.renderedHash === hash) {
            if (!verify || await messages.exists(current.channelId, current.messageId)) return current;
          } else if ((await messages.edit(current.channelId, current.messageId, card.payload)) === "ok") {
            return { ...current, renderedHash: hash };
          }
        }
      }
      const messageId = await messages.send(card.channelId, card.payload);
      if (card.pin) await messages.pin(card.channelId, messageId).catch(() => undefined);
      // The previous message's controls are obsolete: retire it best-effort.
      if (current !== undefined) {
        this.expectRemoval(current.messageId);
        await messages.remove(current.channelId, current.messageId).catch(() => undefined);
      }
      if (failureKey !== undefined) this.failedAt.delete(failureKey);
      return { channelId: card.channelId, messageId, renderedHash: hash, epoch: card.epoch };
    } catch (error) {
      this.options.logger.warn({ err: error, card: card.key }, "A campaign card could not be drawn");
      const code = classifyFailure(error);
      const detail = card.key;
      if (failureKey !== undefined) this.failedAt.set(failureKey, { at: this.now(), detail, code });
      failures?.push({ card: card.key, code, detail });
      return null;
    }
  }

  private readonly failedAt = new Map<string, { at: number; detail: string; code: CampaignIssueCode }>();

  // A card that could not be drawn because Discord was slow or limiting edits
  // would stay stale (a panel still saying the DM is thinking) until the next
  // click or the minute pass. It is tried again on its own, a little later each
  // time, until it draws (the last delay repeats, up to maxRetries in all); the
  // state it shows is always the saved one.
  private readonly retries = new Map<string, { attempt: number; timer: NodeJS.Timeout | null }>();

  private retryTransient(key: CampaignKey, failing: boolean): void {
    const id = `${key.guildId}:${key.campaignId}`;
    const waiting = this.retries.get(id);
    if (!failing) {
      if (waiting?.timer != null) clearTimeout(waiting.timer);
      this.retries.delete(id);
      return;
    }
    const delays = this.options.retryDelaysMs ?? [3_000, 8_000, 20_000, 45_000, 90_000];
    const attempt = waiting?.attempt ?? 0;
    const delay = delays[Math.min(attempt, delays.length - 1)];
    if (waiting?.timer != null || delay === undefined || attempt >= maxRetries) return;
    const timer = setTimeout(() => {
      this.retries.set(id, { attempt: attempt + 1, timer: null });
      void this.sync(key).catch((error: unknown) => this.options.logger.error({ err: error, guildId: key.guildId, campaignId: key.campaignId }, "Campaign card retry failed"));
    }, delay);
    timer.unref();
    this.retries.set(id, { attempt, timer });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  // Messages the bot is deleting itself: their delete events are not a
  // player deleting a card.
  private readonly expectedRemovals = new Map<string, number>();

  private expectRemoval(messageId: string): void {
    const now = Date.now();
    for (const [id, until] of this.expectedRemovals) if (until < now) this.expectedRemovals.delete(id);
    this.expectedRemovals.set(messageId, now + 30_000);
  }

  private takeExpectedRemoval(messageId: string): boolean {
    const until = this.expectedRemovals.get(messageId);
    if (until === undefined) return false;
    this.expectedRemovals.delete(messageId);
    return until >= Date.now();
  }

  private async saveReferences(key: CampaignKey, updates: Readonly<Record<string, CardReference>>, drop: readonly string[]): Promise<void> {
    if (Object.keys(updates).length === 0 && drop.length === 0) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.options.unitOfWork.transaction(async (tx) => {
          const stored = await tx.loadRecord(key);
          if (stored === undefined) return;
          const cards: Record<string, CardReference> = { ...stored.record.cards, ...updates };
          for (const name of drop) delete cards[name];
          await tx.saveRecord({ ...stored.record, cards }, stored.revision);
        });
        return;
      } catch (error) {
        if (!(error instanceof RevisionConflictError)) throw error;
      }
    }
  }
}

// Missing Permissions and Missing Access are the organizer's to fix; an
// Unknown Channel means the channel is gone.
const permissionCodes: readonly number[] = [RESTJSONErrorCodes.MissingPermissions, RESTJSONErrorCodes.MissingAccess];

function classifyFailure(error: unknown): CampaignIssueCode {
  if (error instanceof DiscordAPIError) {
    const code = Number(error.code);
    if (permissionCodes.includes(code)) return "permissions";
    if (code === Number(RESTJSONErrorCodes.UnknownChannel)) return "channelMissing";
    return "cardsFailed";
  }
  return error instanceof Error && /missing (permissions|access)/i.test(error.message) ? "permissions" : "cardsFailed";
}

// The adventure panel is replaced when the round or the combat turn changes.
function panelEpoch(state: StoredCampaign["state"]): string {
  const fight = state.encounter;
  // The sequence moves on with every action, so the panel is redrawn under each result line.
  if (fight !== null && fight.status !== "ended") return `combat:${fight.id}:${fight.turnNumber}:${fight.sequence}`;
  return `round:${state.round?.number ?? state.lastRoundNumber}`;
}

function hashOf(payload: CardPayload): string {
  const hash = createHash("sha1").update(JSON.stringify(payload.components.map((component) => component.toJSON())));
  // A card's pictures are part of what it shows: a new portrait is an edit.
  for (const file of payload.files ?? []) hash.update(file.name).update(file.bytes);
  return hash.digest("hex");
}
