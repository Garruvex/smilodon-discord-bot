import type { AdventureLibrary } from "../../../application/campaign/ports/adventure-library.js";
import type { CampaignPresenter } from "../../../application/campaign/ports/campaign-presenter.js";
import type { CampaignKey, CampaignUnitOfWork } from "../../../application/campaign/ports/campaign-store.js";
import { texts, type Texts } from "../../../application/i18n/texts.js";
import { abilityOf, type CheckTest, type Skill } from "../../../domain/campaign/character/character-sheet.js";
import type { DeliverySpec } from "../../../domain/campaign/engine/engine-request.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import type { CampaignState, CheckState } from "../../../domain/campaign/state/campaign-state.js";
import type { CampaignCardService } from "./campaign-card-service.js";
import type { CampaignMessageGateway } from "./campaign-message-gateway.js";

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
    const say = async (channelId: string | null, content: string | null): Promise<void> => {
      if (channelId !== null && content !== null && content.trim() !== "") await this.options.messages.post(channelId, truncate(content));
    };

    switch (delivery.kind) {
      case "rollResult":
        await say(adventureChannelId, state === undefined ? null : rollLine(events, state, delivery.checkId, text));
        break;
      case "narration":
        await say(adventureChannelId, narration(events, delivery.roundNumber));
        break;
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

// Message keys cannot contain hyphens, so "sleight-of-hand" is "sleightOfHand".
function skillKey(skill: Skill): keyof Texts["campaign"]["skill"] {
  return skill.replace(/-(w)/g, (_match, letter: string) => letter.toUpperCase()) as keyof Texts["campaign"]["skill"];
}

// Discord rejects a message over 2,000 characters.
function truncate(content: string): string {
  return content.length <= 2000 ? content : `${content.slice(0, 1996)}…`;
}
