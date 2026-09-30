import { createHash } from "node:crypto";

import type { AdventureLibrary } from "../../../application/campaign/ports/adventure-library.js";
import type { AdventureBible } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { CampaignPresenter } from "../../../application/campaign/ports/campaign-presenter.js";
import type { CampaignKey, CampaignUnitOfWork } from "../../../application/campaign/ports/campaign-store.js";
import { texts, type Texts } from "../../../application/i18n/texts.js";
import { combatantName, encounterRecords, type CombatBeat } from "../../../application/campaign/dm/combat-records.js";
import { buildOpportunityAttackView, buildReactionView, buildSmiteView } from "../../../application/campaign/views/campaign-views.js";
import { formatDiceExpression } from "../../../domain/campaign/dice/dice-expression.js";
import { combatMode } from "../../../domain/campaign/rules/house-rules.js";
import type { DeliverySpec } from "../../../domain/campaign/engine/engine-request.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import type { CampaignRecord } from "../../../application/campaign/ports/campaign-record.js";
import type { CampaignState, CheckState } from "../../../domain/campaign/state/campaign-state.js";
import type { CampaignCardService } from "./campaign-card-service.js";
import type { CampaignMessageGateway, MessageStyle } from "./campaign-message-gateway.js";
import { checkLabel } from "./text-keys.js";

export interface PresenterOptions {
  readonly unitOfWork: CampaignUnitOfWork;
  readonly messages: CampaignMessageGateway;
  readonly cards: CampaignCardService;
  readonly adventures: AdventureLibrary;
  readonly glossaries: Readonly<Record<string, Glossary>>;
  // How long the "rolls…" line stays before the result replaces it (the
  // staged dice reveal). 0 posts the result at once.
  readonly revealDelayMs?: number;
}

// Puts what the engine decided on the table (plan §6, Combat presentation;
// panel spec, History versus controls). Results and narration are separate
// history messages in the Adventure channel; the live panel is redrawn after
// them so it always sits below the latest output. Everything is rebuilt from
// saved events, so a retry after a failure posts the same words.
export class DiscordCampaignPresenter implements CampaignPresenter {
  public constructor(private readonly options: PresenterOptions) {}

  public async present(key: CampaignKey, delivery: DeliverySpec, deliveryId?: string): Promise<void> {
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
    const { adventurePostId: adventureChannelId, partyPostId: partyChannelId } = record.channels;
    // A delivery's posts carry the same nonces on every retry, so a message
    // that did go out before the failure is not posted twice.
    let posted = 0;
    // A style sets a message apart from the story: dice, actions, rewards, notices and hazards are panels, narration stays prose.
    const say = async (channelId: string | null, content: string | null, mentions: readonly string[] = [], style?: MessageStyle): Promise<string | null> => {
      if (channelId === null || content === null || content.trim() === "") return null;
      posted += 1;
      const nonce = deliveryId === undefined ? undefined : createHash("sha1").update(`${deliveryId}#${posted}`).digest("base64url").slice(0, 25);
      return this.options.messages.post(channelId, truncate(content), mentions, nonce, style);
    };
    // Fights the players play get a template line for every action; on autopilot the round flourish is enough.
    const playersFight = record.houseRules[combatMode.id] !== "autopilot";
    const combat = state === undefined ? null : this.combatText(record, state, events, text);

    switch (delivery.kind) {
      case "rollResult": {
        const line = state === undefined ? null : rollLine(events, state, delivery.checkId, text);
        const delay = this.options.revealDelayMs ?? 0;
        const check = line === null ? undefined : checkOf(events, delivery.checkId);
        if (line === null || check === undefined || delay <= 0 || adventureChannelId === null) {
          await say(adventureChannelId, line, [], "roll");
          break;
        }
        // The staged reveal: the die is thrown, a moment passes, the result lands.
        const rolling = await say(adventureChannelId, text.campaign.msg.rolling({ hero: state?.characters[check.characterId]?.name ?? check.characterId, check: checkLabel(check.test, text) }), [], "roll");
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        if (rolling === null) await say(adventureChannelId, line, [], "roll");
        else if ((await this.options.messages.editText(adventureChannelId, rolling, truncate(line), "roll")) === "missing") await say(adventureChannelId, line, [], "roll");
        break;
      }
      case "narration":
        {
          const told = narration(events, delivery.roundNumber);
          await say(adventureChannelId, told === null || delivery.regenerated !== true ? told : `${text.campaign.msg.retold}\n${told}`);
        }
        break;
      case "opening": {
        const opening = events.findLast((event) => event.kind === "openingRecorded");
        await say(adventureChannelId, opening?.kind === "openingRecorded" ? opening.text : null);
        break;
      }
      case "heroArrival": {
        const joined = events.findLast((event) => event.kind === "heroJoined" && event.sheet.id === delivery.characterId);
        if (joined?.kind === "heroJoined" && joined.entrance !== undefined) await say(adventureChannelId, `${joined.sheet.name} — ${joined.entrance}`);
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
        if (playersFight) await say(adventureChannelId, combat?.action(delivery.attackId) ?? null, [], "action");
        break;
      case "combatBeat":
        if (playersFight) await say(adventureChannelId, combat?.beat(delivery.combatantId, delivery.beat) ?? null, [], "action");
        break;
      case "deathSave":
        if (playersFight) await say(adventureChannelId, combat?.deathSave(delivery.combatantId) ?? null, [], "action");
        break;
      case "speech": {
        const hero = state?.characters[delivery.characterId];
        if (hero !== undefined) await say(adventureChannelId, text.campaign.msg.speech({ hero: hero.name, text: delivery.text }));
        break;
      }
      case "timerReminder": {
        const reminder = state === undefined ? null : this.reminderNotice(state, delivery.target, text);
        if (reminder !== null) await say(adventureChannelId, reminder.content, reminder.userIds);
        break;
      }
      case "campaignPaused":
        // A safety pause is announced without saying who asked.
        if (delivery.reason === "safety") await say(adventureChannelId, text.campaign.msg.safetyPaused);
        break;
      case "itemOffered": {
        // A ping for the hero's owner, who answers on the offer card.
        const offer = state?.offers[delivery.offerId];
        const to = offer === undefined ? undefined : state?.characters[offer.toCharacterId];
        const from = offer === undefined ? undefined : state?.characters[offer.fromCharacterId];
        if (offer !== undefined && to !== undefined && from !== undefined && partyChannelId !== null) {
          const item = this.options.glossaries[record.language]?.names[offer.give] ?? offer.give;
          await say(adventureChannelId, text.campaign.msg.offer({ user: to.ownerUserId, from: from.name, item, channel: partyChannelId }), [to.ownerUserId]);
        }
        break;
      }
      case "combatTurn": {
        // A ping for the player whose turn it now is, unless the turn has already moved on.
        const turn = playersFight && state !== undefined ? this.turnNotice(state, delivery.combatantId, text) : null;
        if (turn !== null) await say(adventureChannelId, turn.content, [turn.userId]);
        break;
      }
      case "fightNotice":
      case "storyNotice":
        await say(adventureChannelId, delivery.text, [], "notice");
        break;
      case "rewardFound": {
        // Gold and items an authored reward gave the party, from the saved loot event.
        const loot = events.findLast((event) => event.kind === "lootFound" && event.encounterId === delivery.rewardId);
        const what = loot?.kind === "lootFound" ? lootText(loot, this.options.glossaries[record.language], text) : null;
        await say(adventureChannelId, what === null ? null : text.campaign.msg.reward({ what }), [], "reward");
        break;
      }
      case "keepsakeGained": {
        const gained = events.findLast((event) => event.kind === "keepsakeGained" && event.keepsake.id === delivery.keepsakeId);
        if (gained?.kind === "keepsakeGained") await say(adventureChannelId, text.campaign.msg.keepsake({ name: gained.keepsake.name, description: gained.keepsake.description }), [], "reward");
        break;
      }
      case "paymentMade":
        await say(adventureChannelId, text.campaign.msg.payment({ hero: state?.characters[delivery.characterId]?.name ?? delivery.characterId, amount: delivery.amount }), [], "reward");
        break;
      case "encounterEnded": {
        const ended = this.encounterEnd(events, delivery.encounterId, text, this.options.glossaries[record.language]);
        await say(adventureChannelId, ended?.text ?? null, [], ended?.style);
        break;
      }
      case "reactionOffered": {
        // The waiting notice, pinging the target; the decision card itself is
        // drawn by the cards.sync() below (a hit can't wait on the reaction
        // more than once at a time, so there is nothing else to disambiguate here).
        const bible = this.options.adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
        const glossary = this.options.glossaries[record.language];
        const view = state === undefined || bible === undefined || glossary === undefined ? null : buildReactionView(state, bible, glossary);
        if (view !== null) {
          const notice =
            view.trigger === "spell"
              ? text.campaign.msg.reactionSpell({ user: view.targetUserId, attacker: view.attackerName, spell: view.spellName ?? "" })
              : view.trigger === "damage"
                ? text.campaign.msg.reactionDamage({ user: view.targetUserId, attacker: view.attackerName })
                : text.campaign.msg.reactionOffered({ user: view.targetUserId, attacker: view.attackerName });
          await say(adventureChannelId, notice, [view.targetUserId]);
        }
        break;
      }
      case "smiteOffered": {
        // Same pattern as reactionOffered: the ping here, the decision card
        // itself drawn by the cards.sync() below.
        const bible = this.options.adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
        const glossary = this.options.glossaries[record.language];
        const view = state === undefined || bible === undefined || glossary === undefined ? null : buildSmiteView(state, bible, glossary);
        if (view !== null) await say(adventureChannelId, text.campaign.msg.smiteOffered({ user: view.attackerUserId, target: view.targetName }), [view.attackerUserId]);
        break;
      }
      case "opportunityAttackOffered": {
        // Same pattern as reactionOffered/smiteOffered: the ping here, the
        // decision card itself drawn by the cards.sync() below.
        const bible = this.options.adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
        const glossary = this.options.glossaries[record.language];
        const view = state === undefined || bible === undefined || glossary === undefined ? null : buildOpportunityAttackView(state, bible, glossary);
        if (view !== null) {
          await say(adventureChannelId, text.campaign.msg.opportunityAttackOffered({ user: view.provokerUserId, mover: view.moverName }), [view.provokerUserId]);
        }
        break;
      }
      case "tradeNarrated":
      case "dialogueNarrated":
      case "utilityCastNarrated":
      case "hazardNarrated": {
        // What a hero did between fights: the plain facts the engine decided, then the Narrator’s line.
        const bible = this.options.adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
        const glossary = this.options.glossaries[record.language];
        if (state !== undefined && bible !== undefined && glossary !== undefined) await say(adventureChannelId, outsideCombatText(delivery, events, state, bible, glossary, text));
        break;
      }
      case "healingSettled": {
        // A healing spell between fights: what was rolled and restored, from the saved event alone.
        const settled = events.findLast((event) => event.kind === "healingSettled" && event.healing.id === delivery.healingId);
        const glossary = this.options.glossaries[record.language];
        if (settled?.kind === "healingSettled" && state !== undefined && glossary !== undefined) {
          const { healing } = settled;
          const heroOf = (id: string): string => state.characters[id]?.name ?? id;
          await say(
            adventureChannelId,
            text.campaign.msg.healLine({
              hero: heroOf(healing.casterId),
              spell: glossary.names[healing.spellId] ?? healing.spellId,
              level: healing.slotLevel,
              target: heroOf(healing.targetId),
              dice: formatDiceExpression(healing.expression),
              rolled: healing.rolled,
              healed: healing.healed,
              hp: healing.hpAfter,
              max: state.characters[healing.targetId]?.maxHp ?? healing.hpAfter,
            }),
          );
        }
        break;
      }
      case "environmentalDamage": {
        // Damage between fights (a fall, drowning): what was rolled and where it leaves the hero, from the saved event alone.
        const settled = events.findLast((event) => event.kind === "environmentalDamageSettled" && event.damage.id === delivery.damageId);
        if (settled?.kind === "environmentalDamageSettled" && state !== undefined) {
          const { damage } = settled;
          const hero = state.characters[damage.characterId]?.name ?? damage.characterId;
          const max = state.characters[damage.characterId]?.maxHp ?? damage.hpAfter;
          const m = text.campaign.msg;
          const line = damage.dead ? m.envDamageDead({ hero }) : damage.hpAfter === 0 ? m.envDamageDown({ hero }) : m.envDamageHurt({ hero, taken: damage.taken, hp: damage.hpAfter, max });
          await say(adventureChannelId, `${m.envCause[damage.cause]} ${line}`, [], "hazard");
        }
        break;
      }
      default:
        // Panel-only changes (waiting, paused, turns): the redraw below is the whole delivery.
        break;
    }
    // The panel is redrawn after the history line, so it stays below it.
    await this.options.cards.sync(key);
  }

  // Halfway through a long wait: only the players still being waited for are
  // named. Discord shows the time left in each reader's own clock.
  private reminderNotice(state: CampaignState, target: Extract<DeliverySpec, { kind: "timerReminder" }>["target"], text: Texts): { readonly content: string; readonly userIds: readonly string[] } | null {
    const when = (at: number): string => `<t:${Math.floor(at / 1000)}:R>`;
    const present = (userId: string): boolean => state.members[userId]?.availability === "present";
    if (target.kind === "round") {
      const round = state.round;
      if (round?.number !== target.roundNumber) return null;
      const waiting = round.participants.filter((id) => round.submissions[id] === undefined).flatMap((id) => (state.characters[id] === undefined ? [] : [state.characters[id].ownerUserId]));
      const users = [...new Set(waiting.filter(present))];
      return users.length === 0 ? null : { content: text.campaign.msg.reminderRound({ users: users.map((id) => `<@${id}>`).join(" "), when: when(target.closesAt) }), userIds: users };
    }
    if (target.kind === "roll") {
      const check = state.checks[target.checkId];
      const hero = check === undefined ? undefined : state.characters[check.characterId];
      if (hero === undefined || !present(hero.ownerUserId)) return null;
      return { content: text.campaign.msg.reminderRoll({ user: `<@${hero.ownerUserId}>`, hero: hero.name, when: when(target.deadline) }), userIds: [hero.ownerUserId] };
    }
    const encounter = state.encounter;
    const combatant = encounter?.combatants[encounter.order[encounter.turnIndex] ?? ""];
    const hero = combatant?.source.kind === "hero" ? state.characters[combatant.source.characterId] : undefined;
    if (hero === undefined || !present(hero.ownerUserId)) return null;
    return { content: text.campaign.msg.reminderTurn({ user: `<@${hero.ownerUserId}>`, hero: hero.name, when: when(target.endsAt) }), userIds: [hero.ownerUserId] };
  }

  private turnNotice(state: CampaignState, combatantId: string, text: Texts): { readonly content: string; readonly userId: string } | null {
    const encounter = state.encounter;
    if (encounter === null || encounter.status !== "active" || encounter.order[encounter.turnIndex] !== combatantId) return null;
    const combatant = encounter.combatants[combatantId];
    if (combatant?.condition !== "active" || combatant.source.kind !== "hero") return null;
    const sheet = state.characters[combatant.source.characterId];
    if (sheet === undefined) return null;
    if (state.members[sheet.ownerUserId]?.availability !== "present") {
      // An away owner's hero waits for the player they named, when that player is here.
      const proxy = state.proxies?.[sheet.ownerUserId];
      if (proxy === undefined || state.members[proxy]?.availability !== "present") return null;
      return { content: text.campaign.msg.proxyTurn({ user: proxy, hero: sheet.name, owner: sheet.ownerUserId }), userId: proxy };
    }
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
    beat(combatantId: string, beat: "dodge" | "dash" | "disengage" | "useItem" | "fled" | "reaction" | "counterspell"): string | null;
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
          case "reaction":
            return t.combatReaction({ actor });
          case "counterspell":
            return t.combatCounterspell({ actor });
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

  private encounterEnd(events: readonly CampaignEvent[], encounterId: string, text: Texts, glossary: Glossary | undefined): { readonly text: string; readonly style: MessageStyle } | null {
    const ended = events.findLast((event) => event.kind === "encounterEnded");
    const lines: string[] = [];
    if (ended?.kind === "encounterEnded") lines.push(ended.outcome === "victory" ? text.campaign.msg.encounterVictory : text.campaign.msg.encounterDefeat);
    const loot = events.findLast((event) => event.kind === "lootFound" && event.encounterId === encounterId);
    const found = loot?.kind === "lootFound" ? lootText(loot, glossary, text) : null;
    if (found !== null) lines.push(text.campaign.msg.loot({ items: found }));
    return lines.length === 0 ? null : { text: lines.join("\n"), style: found === null ? "notice" : "reward" };
  }
}

// The items and gold a loot event gave the party, in words; null when it gave nothing.
function lootText(loot: Extract<CampaignEvent, { kind: "lootFound" }>, glossary: Glossary | undefined, text: Texts): string | null {
  const parts = [...loot.items.map((item) => glossary?.names[item] ?? item), ...(loot.gold > 0 ? [text.campaign.msg.goldAmount({ gold: loot.gold })] : [])];
  return parts.length === 0 ? null : parts.join(", ");
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

// Discord rejects a message over 2,000 characters.
function truncate(content: string): string {
  return content.length <= 2000 ? content : `${content.slice(0, 1996)}…`;
}

const passed = (success: boolean, text: Texts): string => (success ? text.campaign.msg.checkPassed : text.campaign.msg.checkFailed);

// The table-facing words for a trade, a conversation, a ritual or a hazard:
// what the dice and the ledger decided, in a line, then what the Narrator
// made of it. The numbers come from the saved events, never from the model.
function outsideCombatText(
  delivery: Extract<DeliverySpec, { kind: "tradeNarrated" | "dialogueNarrated" | "utilityCastNarrated" | "hazardNarrated" }>,
  events: readonly CampaignEvent[],
  state: CampaignState,
  bible: AdventureBible,
  glossary: Glossary,
  text: Texts,
): string | null {
  const t = text.campaign.msg;
  const nameOf = (id: string): string => glossary.names[id] ?? id;
  const heroOf = (id: string): string => state.characters[id]?.name ?? id;
  const npcOf = (id: string): string => bible.npcs.find((npc) => npc.id === id)?.name ?? id;
  const join = (facts: readonly string[], told: string | undefined): string | null => (told === undefined ? null : [...facts, "", told].join("\n"));
  switch (delivery.kind) {
    case "tradeNarrated": {
      const settled = events.findLast((event) => event.kind === "tradeSettled" && event.trade.id === delivery.tradeId);
      const told = events.findLast((event) => event.kind === "tradeNarrated" && event.tradeId === delivery.tradeId);
      if (settled?.kind !== "tradeSettled" || told?.kind !== "tradeNarrated") return null;
      const { trade } = settled;
      const values = { hero: heroOf(trade.characterId), npc: npcOf(trade.npcId), item: nameOf(trade.itemId), price: trade.finalPrice };
      const line = trade.outcome === "cannotAfford" ? t.tradeBroke(values) : trade.direction === "buy" ? t.tradeBuy(values) : t.tradeSell(values);
      const haggle = trade.haggle === null ? [] : [t.tradeHaggle({ skill: checkLabel(trade.haggle.test, text), total: trade.haggle.total, dc: trade.haggle.dc, result: passed(trade.haggle.success, text), listed: trade.listedPrice })];
      return join([line, ...haggle], told.text);
    }
    case "dialogueNarrated": {
      const settled = events.findLast((event) => event.kind === "dialogueSettled" && event.dialogue.id === delivery.dialogueId);
      const told = events.findLast((event) => event.kind === "dialogueNarrated" && event.dialogueId === delivery.dialogueId);
      if (settled?.kind !== "dialogueSettled" || told?.kind !== "dialogueNarrated") return null;
      const { dialogue } = settled;
      const hero = heroOf(dialogue.characterId);
      const npc = npcOf(dialogue.npcId);
      const line =
        dialogue.kind === "ask" || dialogue.check === null
          ? t.askLine({ hero, npc, question: dialogue.question ?? "" })
          : t.pressLine({ hero, npc, skill: checkLabel(dialogue.check.test, text), total: dialogue.check.total, dc: dialogue.check.dc, result: passed(dialogue.check.success, text) });
      return join([line], told.text);
    }
    case "utilityCastNarrated": {
      const cast = events.findLast((event) => event.kind === "utilitySpellCast" && event.cast.id === delivery.castId);
      const told = events.findLast((event) => event.kind === "utilityCastNarrated" && event.castId === delivery.castId);
      if (cast?.kind !== "utilitySpellCast" || told?.kind !== "utilityCastNarrated") return null;
      return join([t.castLine({ hero: heroOf(cast.cast.characterId), spell: nameOf(cast.cast.spellId) })], told.text);
    }
    case "hazardNarrated": {
      const settled = events.findLast((event) => event.kind === "hazardSettled" && event.hazard.id === delivery.hazardId);
      const told = events.findLast((event) => event.kind === "hazardNarrated" && event.hazardId === delivery.hazardId);
      if (settled?.kind !== "hazardSettled" || told?.kind !== "hazardNarrated") return null;
      const { hazard } = settled;
      const line = t.hazardLine({ hero: heroOf(hazard.characterId), ability: text.campaign.ability[hazard.ability], dc: hazard.dc, total: hazard.total, result: passed(hazard.success, text) });
      return join([line, ...(hazard.exhaustionGained > 0 ? [t.hazardExhausted] : [])], told.text);
    }
  }
}
