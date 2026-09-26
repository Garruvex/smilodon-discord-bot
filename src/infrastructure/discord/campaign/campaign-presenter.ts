import type { AdventureLibrary } from "../../../application/campaign/ports/adventure-library.js";
import type { CampaignPresenter } from "../../../application/campaign/ports/campaign-presenter.js";
import type { CampaignKey, CampaignUnitOfWork } from "../../../application/campaign/ports/campaign-store.js";
import { texts, type Texts } from "../../../application/i18n/texts.js";
import { combatantName, encounterRecords, type CombatBeat } from "../../../application/campaign/dm/combat-records.js";
import { abilityOf, type CheckTest } from "../../../domain/campaign/character/character-sheet.js";
import { combatMode } from "../../../domain/campaign/rules/house-rules.js";
import type { DeliverySpec } from "../../../domain/campaign/engine/engine-request.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import type { CampaignRecord } from "../../../application/campaign/ports/campaign-record.js";
import type { CampaignState, CheckState } from "../../../domain/campaign/state/campaign-state.js";
import type { CampaignCardService } from "./campaign-card-service.js";
import type { CampaignMessageGateway } from "./campaign-message-gateway.js";
import { skillKey } from "./text-keys.js";

export interface PresenterOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly messages: CampaignMessageGateway;
  readonly cards: CampaignCardService;
  readonly adventures: AdventureLibrary;
  readonly glossaries: Readonly<Record<string, Glossary>>;
}

// Puts what the engine decided on the table (plan §6, Combat presentation;
// panel spec, History versus controls). Results and narration are separate
// history messages in the Adventure channel; the live panel is redrawn after
// them so it always sits below the latest output. Everything is rebuilt from
// saved events, so a retry after a failure posts the same words.
export class DiscordCampaignPresenter implements CampaignPresenter {
  public constructor(private readonly options: PresenterOptions) {}

  public async present(key: CampaignKey, delivery: DeliverySpec): Promise<void> {
    const loaded = await this.options.unitOfWork.transaction(async (tx) => ({
      stored: await tx.loadRecord(key),
      campaign: await tx.loadCampaign(key),
      envelopes: await tx.readEvents(key),
    }));
    if (loaded.stored === undefined) return;
    const { record } = loaded.stored;
    const events = loaded.envelopes.map((envelope) => envelope.event);
    const state = loaded.campaign?.state;
    const text = texts[record.language];
    const { adventureChannelId, partyChannelId } = record.channels;
    const say = async (channelId: string | null, content: string | null, mentions: readonly string[] = []): Promise<void> => {
      if (channelId !== null && content !== null && content.trim() !== "") await this.options.messages.post(channelId, truncate(content), mentions);
    };
    // Fights the players play get a template line for every action; on autopilot the round flourish is enough.
    const playersFight = record.houseRules[combatMode.id] !== "autopilot";
    const combat = state === undefined ? null : this.combatText(record, state, events, text);

    switch (delivery.kind) {
      case "rollResult":
        await say(adventureChannelId, state === undefined ? null : rollLine(events, state, delivery.checkId, text));
        break;
      case "narration":
        await say(adventureChannelId, narration(events, delivery.roundNumber));
        break;
      case "opening": {
        const opening = events.findLast((event) => event.kind === "openingRecorded");
        await say(adventureChannelId, opening?.kind === "openingRecorded" ? opening.text : null);
        break;
      }
      case "quietRound":
        await say(adventureChannelId, text.campaign.msg.quiet);
        break;
      case "dmHolding":
        await say(adventureChannelId, text.campaign.msg.holding);
        break;
      case "organizerNotice":
        await say(partyChannelId ?? adventureChannelId, text.campaign.msg.plannerFailed({ organizer: `<@${record.organizerId}>`, round: delivery.roundNumber }));
        break;
      case "encounterStarted": {
        const bible = this.options.adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
        const description = bible?.encounters.find((encounter) => encounter.id === delivery.encounterId.replace(/~\d+$/, ""))?.publicDescription;
        await say(adventureChannelId, description === undefined ? null : text.campaign.msg.encounterStart({ description }));
        break;
      }
      case "combatNarration":
        await say(adventureChannelId, combatNarration(events, delivery.round));
        break;
      case "attackResolved":
        if (playersFight) await say(adventureChannelId, combat?.action(delivery.attackId) ?? null);
        break;
      case "combatBeat":
        if (playersFight) await say(adventureChannelId, combat?.beat(delivery.combatantId, delivery.beat) ?? null);
        break;
      case "deathSave":
        if (playersFight) await say(adventureChannelId, combat?.deathSave(delivery.combatantId) ?? null);
        break;
      case "combatTurn": {
        // A ping for the player whose turn it now is, unless the turn has already moved on.
        const turn = playersFight && state !== undefined ? this.turnNotice(state, delivery.combatantId, text) : null;
        if (turn !== null) await say(adventureChannelId, turn.content, [turn.userId]);
        break;
      }
      case "encounterEnded":
        await say(adventureChannelId, this.encounterEnd(events, delivery.encounterId, text, this.options.glossaries[record.language]));
        break;
      default:
        // Panel-only changes (waiting, paused, turns): the redraw below is the whole delivery.
        break;
    }
    // The panel is redrawn after the history line, so it stays below it.
    await this.options.cards.sync(key);
  }

  private turnNotice(state: CampaignState, combatantId: string, text: Texts): { readonly content: string; readonly userId: string } | null {
    const encounter = state.encounter;
    if (encounter === null || encounter.status !== "active" || encounter.order[encounter.turnIndex] !== combatantId) return null;
    const combatant = encounter.combatants[combatantId];
    if (combatant?.condition !== "active" || combatant.source.kind !== "hero") return null;
    const sheet = state.characters[combatant.source.characterId];
    if (sheet === undefined || state.members[sheet.ownerUserId]?.availability !== "present") return null;
    return { content: text.campaign.msg.yourTurn({ user: sheet.ownerUserId, hero: sheet.name }), userId: sheet.ownerUserId };
  }

  // Template lines for what happened in a fight, rebuilt from saved events.
  private combatText(
    record: CampaignRecord,
    state: CampaignState,
    events: readonly CampaignEvent[],
    text: Texts,
  ): {
    action(attackId: string): string | null;
    beat(combatantId: string, beat: "dodge" | "dash" | "disengage" | "useItem" | "fled"): string | null;
    deathSave(combatantId: string): string | null;
  } | null {
    const bible = this.options.adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
    const glossary = this.options.glossaries[record.language];
    if (bible === undefined || glossary === undefined) return null;
    const names = { state, bible, glossary };
    const nameOf = (combatantId: string): string => {
      const combatant = state.encounter?.combatants[combatantId];
      return combatant === undefined ? combatantId : combatantName(combatant, names);
    };
    const t = text.campaign.msg;
    return {
      action: (attackId): string | null => {
        const beat = encounterRecords(events, names)
          .flatMap((encounter) => encounter.rounds)
          .flatMap((round) => round.beats)
          .find((candidate) => candidate.kind === "action" && candidate.resolutionId === attackId);
        return beat?.kind === "action" ? actionLine(beat, text) : null;
      },
      beat: (combatantId, beat): string => {
        const actor = nameOf(combatantId);
        switch (beat) {
          case "dodge":
            return t.combatDodge({ actor });
          case "dash":
            return t.combatDash({ actor });
          case "disengage":
            return t.combatDisengage({ actor });
          case "useItem":
            return t.combatUseItem({ actor });
          case "fled":
            return t.combatFled({ actor });
        }
      },
      deathSave: (combatantId): string | null => {
        const saved = events.findLast((event) => event.kind === "deathSaveRolled" && event.combatantId === combatantId);
        if (saved?.kind !== "deathSaveRolled") return null;
        const result = saved.condition === "stable" ? t.deathStable : saved.condition === "dead" ? t.deathDead : saved.condition === "active" ? t.deathRises : t.deathHolds;
        return t.combatDeathSave({ actor: nameOf(combatantId), result: `${result} (${saved.roll.d20.natural})` });
      },
    };
  }

  private encounterEnd(events: readonly CampaignEvent[], encounterId: string, text: Texts, glossary: Glossary | undefined): string | null {
    const ended = events.findLast((event) => event.kind === "encounterEnded");
    const lines: string[] = [];
    if (ended?.kind === "encounterEnded") lines.push(ended.outcome === "victory" ? text.campaign.msg.encounterVictory : text.campaign.msg.encounterDefeat);
    const loot = events.findLast((event) => event.kind === "lootFound" && event.encounterId === encounterId);
    if (loot?.kind === "lootFound" && loot.items.length > 0) {
      lines.push(text.campaign.msg.loot({ items: loot.items.map((item) => glossary?.names[item] ?? item).join(", ") }));
    }
    return lines.length === 0 ? null : lines.join("\n");
  }
}

// "⚔️ Mira · Shortsword → Goblin A: hit, 7 damage, down".
function actionLine(beat: Extract<CombatBeat, { kind: "action" }>, text: Texts): string {
  const t = text.campaign.msg;
  const results = beat.targets.map((target) => {
    const parts: string[] = [];
    const damage = Math.max(0, -target.hpChange);
    switch (target.check) {
      case "hit":
        parts.push(t.combatHit({ damage }));
        break;
      case "critical":
        parts.push(t.combatCritical({ damage }));
        break;
      case "miss":
        parts.push(t.combatMiss);
        break;
      case "saved":
        parts.push(damage > 0 ? `${t.combatSaved}, ${t.combatDamage({ damage })}` : t.combatSaved);
        break;
      case "failed":
        parts.push(damage > 0 ? `${t.combatFailed}, ${t.combatDamage({ damage })}` : t.combatFailed);
        break;
      case null:
        if (damage > 0) parts.push(t.combatDamage({ damage }));
        else if (target.hpChange > 0) parts.push(t.combatHeal({ amount: target.hpChange }));
        break;
    }
    if (target.condition === "dead") parts.push(t.combatDead);
    else if (target.condition === "unconscious" || target.condition === "stable") parts.push(t.combatDown);
    if (target.knockedProne) parts.push(t.combatProne);
    return parts.length === 0 ? target.name : t.combatTarget({ name: target.name, result: parts.join(", ") });
  });
  const line = { actor: beat.actor, using: beat.using, results: results.join("; ") };
  return beat.opportunity ? t.combatOpportunity(line) : t.combatAction(line);
}

function narration(events: readonly CampaignEvent[], roundNumber: number): string | null {
  const found = events.findLast((event) => event.kind === "narrationRecorded" && event.roundNumber === roundNumber);
  return found?.kind === "narrationRecorded" ? found.text : null;
}

function combatNarration(events: readonly CampaignEvent[], round: number): string | null {
  const found = events.findLast((event) => event.kind === "combatNarrationRecorded" && event.round === round);
  return found?.kind === "combatNarrationRecorded" ? found.text : null;
}

function checkOf(events: readonly CampaignEvent[], checkId: string): CheckState | undefined {
  for (const event of events.toReversed()) {
    if (event.kind !== "roundPlanApplied") continue;
    const found = event.checks.find((candidate) => candidate.id === checkId);
    if (found !== undefined) return found;
  }
  return undefined;
}

function rollLine(events: readonly CampaignEvent[], state: CampaignState, checkId: string, text: Texts): string | null {
  const resolved = events.findLast((event) => event.kind === "checkResolved" && event.checkId === checkId);
  if (resolved?.kind !== "checkResolved") return null;
  const check = checkOf(events, checkId);
  if (check === undefined) return null;
  const started = events.findLast((event) => event.kind === "checkRollStarted" && event.checkId === checkId);
  const { roll, moments, success } = resolved.result;
  const modifier = roll.d20.modifier;
  const headline = moments.headline?.kind;
  const outcome = headline === "natural20" ? text.campaign.msg.rollCritical : headline === "natural1" ? text.campaign.msg.rollFumble : success ? text.campaign.msg.rollSuccess : text.campaign.msg.rollFailure;
  const line = text.campaign.msg.roll({
    hero: state.characters[check.characterId]?.name ?? check.characterId,
    check: checkLabel(check.test, text),
    natural: roll.d20.natural,
    modifier: modifier >= 0 ? `+ ${modifier}` : `− ${Math.abs(modifier)}`,
    total: roll.total,
    dc: check.dc,
    outcome: `${success ? "✅" : "❌"} ${outcome}`,
  });
  return started?.kind === "checkRollStarted" && started.timedOut ? `${line} ${text.campaign.msg.rollTimedOut}` : line;
}

// The English abbreviation sits next to the localized name, where players cross-check rules.
function checkLabel(test: CheckTest, text: Texts): string {
  const ability = abilityOf(test);
  const name = test.kind === "skill" ? text.campaign.skill[skillKey(test.skill)] : text.campaign.ability[ability];
  return `${name} (${ability.toUpperCase()})`;
}

// Discord rejects a message over 2,000 characters.
function truncate(content: string): string {
  return content.length <= 2000 ? content : `${content.slice(0, 1996)}…`;
}
