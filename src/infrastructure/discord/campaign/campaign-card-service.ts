import { createHash } from "node:crypto";

import { KeyedSerialQueue } from "../../../application/concurrency/keyed-serial-queue.js";
import type { AdventureLibrary } from "../../../application/campaign/ports/adventure-library.js";
import type { CardRefresher } from "../../../application/campaign/ports/card-refresher.js";
import type { CampaignRecord, CardReference } from "../../../application/campaign/ports/campaign-record.js";
import { RevisionConflictError, type CampaignKey, type CampaignUnitOfWork, type StoredCampaign } from "../../../application/campaign/ports/campaign-store.js";
import type { RuntimeLogger } from "../../../application/campaign/campaign-runtime.js";
import type { RulesetCatalog } from "../../../application/campaign/rules/ruleset-catalog.js";
import {
  buildLobbyView,
  type PanelView,
  buildPanelView,
  buildPartyView,
} from "../../../application/campaign/views/campaign-views.js";
import type { Language } from "../../../application/i18n/language.js";
import { texts as allTexts } from "../../../application/i18n/texts.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import { renderAdventurePanel } from "./adventure-panel.js";
import { renderCampaignCard } from "./campaign-card.js";
import type { CampaignMessageGateway } from "./campaign-message-gateway.js";
import type { CardPayload } from "./card-payload.js";
import { renderHeroCard } from "./hero-card.js";
import { renderHubControl, renderHubGame, type HubGame } from "./hub-card.js";
import { renderLobbyCard } from "./lobby-card.js";

export interface CampaignCardServiceOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly rulesets: RulesetCatalog;
  readonly adventures: AdventureLibrary;
  readonly messages: CampaignMessageGateway;
  readonly glossaries: Readonly<Record<string, Glossary>>;
  readonly logger: RuntimeLogger;
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
export class CampaignCardService implements CardRefresher {
  private readonly queue = new KeyedSerialQueue();
  private readonly scheduled = new Set<string>();

  public constructor(private readonly options: CampaignCardServiceOptions) {}

  // Coalesced and in the background: requests that arrive while one is queued
  // share it, and a failure is logged, never thrown at the game.
  public refresh(key: CampaignKey): void {
    const id = `${key.guildId}:${key.campaignId}`;
    if (this.scheduled.has(id)) return;
    this.scheduled.add(id);
    void this.queue.run(id, async () => {
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

  private async syncNow(key: CampaignKey, verify = false): Promise<void> {
    const loaded = await this.options.unitOfWork.transaction(async (tx) => ({ stored: await tx.loadRecord(key), campaign: await tx.loadCampaign(key) }));
    if (loaded.stored === undefined) return;
    const { record } = loaded.stored;
    const desired = this.desiredCards(record, loaded.campaign);
    const updates: Record<string, CardReference> = {};
    // A lobby card becomes the campaign card in place when the adventure starts.
    const inherited = record.cards.party === undefined && record.cards.lobby !== undefined ? { party: record.cards.lobby } : {};
    const existing: Readonly<Record<string, CardReference>> = { ...record.cards, ...inherited };
    for (const card of desired) {
      const reference = await this.place(card, existing[card.key], verify);
      if (reference !== null) updates[card.key] = reference;
    }
    await this.saveReferences(key, updates, record.lifecycle === "lobby" ? [] : ["lobby"]);
    await this.syncHub(key.guildId, verify);
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
    // The hub speaks the server's default (English) unless every live game shares a language.
    const languages = new Set(live.map(({ record }) => record.language));
    const language: Language = languages.size === 1 && languages.has("zh-TW") ? "zh-TW" : "en";
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
        partyChannelId: record.channels.partyChannelId,
        adventureChannelId: record.channels.adventureChannelId,
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

  private desiredCards(record: CampaignRecord, campaign: StoredCampaign | undefined): readonly DesiredCard[] {
    const language: Language = record.language;
    const text = allTexts[language];
    const campaignId = record.key.campaignId;
    const { partyChannelId, adventureChannelId, discussionThreadId } = record.channels;
    const summary = this.options.adventures.list().find((adventure) => adventure.id === record.adventure.adventureId);
    const presets = summary?.heroes.map((hero) => ({ id: hero.id, name: hero.name, className: hero.class })) ?? [];
    const cards: DesiredCard[] = [];

    if (record.lifecycle === "lobby" || campaign === undefined) {
      if (partyChannelId !== null) {
        const document = this.options.adventures.document(record.adventure.adventureId, record.language);
        const view = buildLobbyView(record, document?.bible.title ?? record.name, document?.heroes.map((hero) => ({ id: hero.id, name: hero.name, className: hero.class })) ?? presets);
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
            mode: panel.mode,
            language: record.language,
            pacingPreset: record.pacingPreset,
            organizerId: record.organizerId,
            heroes,
            adventureUrl: guildUrl(adventureChannelId),
            talkUrl: guildUrl(discussionThreadId),
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
          payload: renderHeroCard(hero, text, campaignId, (id) => glossary.names[id] ?? id),
          epoch: "hero",
          pin: false,
        });
      }
    }
    if (adventureChannelId !== null) {
      cards.push({ key: "adventure", channelId: adventureChannelId, payload: renderAdventurePanel(panel, text, campaignId), epoch: panelEpoch(state), pin: false });
    }
    return cards;
  }

  // Edits the card in place when it is unchanged in identity, replaces it when
  // the message is gone or the round/turn moved on. Returns the reference to
  // save, or null when nothing could be drawn (the failure is logged and the
  // next sync tries again).
  private async place(card: DesiredCard, current: CardReference | undefined, verify = false): Promise<CardReference | null> {
    const hash = hashOf(card.payload);
    const { messages } = this.options;
    try {
      if (current !== undefined && current.channelId === card.channelId) {
        if (current.epoch === card.epoch) {
          if (current.renderedHash === hash && !verify) return current;
          if ((await messages.edit(current.channelId, current.messageId, card.payload)) === "ok") return { ...current, renderedHash: hash };
        }
      }
      const messageId = await messages.send(card.channelId, card.payload);
      if (card.pin) await messages.pin(card.channelId, messageId).catch(() => undefined);
      // The previous message's controls are obsolete: retire it best-effort.
      if (current !== undefined) {
        this.expectRemoval(current.messageId);
        await messages.remove(current.channelId, current.messageId).catch(() => undefined);
      }
      return { channelId: card.channelId, messageId, renderedHash: hash, epoch: card.epoch };
    } catch (error) {
      this.options.logger.warn({ err: error, card: card.key }, "A campaign card could not be drawn");
      return null;
    }
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

// The adventure panel is replaced when the round or the combat turn changes.
function panelEpoch(state: StoredCampaign["state"]): string {
  const fight = state.encounter;
  if (fight !== null && fight.status !== "ended") return `combat:${fight.id}:${fight.turnNumber}`;
  return `round:${state.round?.number ?? state.lastRoundNumber}`;
}

function hashOf(payload: CardPayload): string {
  return createHash("sha1").update(JSON.stringify(payload.components.map((component) => component.toJSON()))).digest("hex");
}

