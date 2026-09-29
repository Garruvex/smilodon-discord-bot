import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";

import type { AdventureLibrary } from "../../../application/campaign/ports/adventure-library.js";
import type { CampaignLobbyService } from "../../../application/campaign/campaign-lobby-service.js";
import type { CampaignPlayController, PlayResult } from "../../../application/campaign/campaign-play-controller.js";
import type { CampaignRecord } from "../../../application/campaign/ports/campaign-record.js";
import type { CampaignKey, CampaignUnitOfWork } from "../../../application/campaign/ports/campaign-store.js";
import type { AdventureBible } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { CampaignEvent } from "../../../domain/campaign/events/campaign-event.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";
import type { RulesetCatalog } from "../../../application/campaign/rules/ruleset-catalog.js";
import { buildHeroView } from "../../../application/campaign/views/campaign-views.js";
import { CommandModule } from "../../../application/commands/command.js";
import type { ComponentContext, ComponentHandler, ModalContext } from "../../../application/components/component-handler.js";
import { texts, type Texts } from "../../../application/i18n/texts.js";
import { publicAccessPolicy } from "../../../domain/access/access-policy.js";
import { freeHeroes } from "../../../domain/campaign/lobby/lobby.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import type { CharacterId } from "../../../domain/campaign/core/ids.js";
import { maxSpeechLength } from "../../../domain/campaign/engine/speech.js";
import type { CombatCommand } from "../../../domain/campaign/commands/campaign-command.js";
import { abilities, type Ability } from "../../../domain/campaign/rules/effects.js";
import { buildTurnView, type TurnView } from "../../../application/campaign/views/turn-view.js";
import { encodeChoice, parseAim, parseChoice, renderEndConfirm, renderShapeMenu, renderSpellMenu, renderTargetMenu, renderTurnMenu, type TurnChoice, type TurnMenu } from "../campaign/turn-menu.js";
import type { CampaignAction } from "../campaign/campaign-ids.js";
import { campaignCustomId, campaignIdPrefix, parseCampaignId } from "../campaign/campaign-ids.js";
import type { ContentId } from "../../../domain/campaign/rules/content-id.js";
import { isWorn } from "../../../domain/campaign/combat/combatant-profile.js";
import { isFallen } from "../../../domain/campaign/state/campaign-state.js";
import { combatantName } from "../../../application/campaign/dm/combat-records.js";
import { classLabel } from "../campaign/text-keys.js";
import { giveMenu, packMenu, parseGift, parsePackChoice } from "../campaign/pack-menu.js";
import { CampaignCardService } from "../campaign/campaign-card-service.js";
import { renderHeroSheet } from "../campaign/hero-sheet.js";
import type { HeroPictures } from "../campaign/hero-pictures.js";
import type { CharacterLibrary } from "../../../application/campaign/library/character-library.js";
import { libraryHeroRef, savedSnapshotIdOf } from "../../../application/campaign/library/library-types.js";
import { conflictLines } from "./character-library-component-handler.js";
import { buildJournal, buildRecap } from "../../../application/campaign/views/story-views.js";
import { actingHero } from "../../../domain/campaign/engine/members.js";
import { renderRulesScreen, ruleLines } from "../campaign/rules-screen.js";
import { houseRulePresets, levelingMode } from "../../../domain/campaign/rules/house-rules.js";
import { maxLevel } from "../../../domain/campaign/character/leveling.js";
import { renderLevelForm } from "../campaign/level-up-form.js";
import { ExploreFlow, isExploreAction } from "../campaign/explore-flow.js";
import { refusalText } from "../campaign/refusal-text.js";

// Joins lines, dropping the earliest content lines when they do not fit, so the latest news survives.
function fit(lines: readonly string[], limit: number): string {
  const kept = [...lines];
  while (kept.join("\n").length > limit && kept.length > 3) kept.splice(2, 1);
  const joined = kept.join("\n");
  return joined.length <= limit ? joined : `${joined.slice(0, limit - 1)}…`;
}

export interface CampaignComponentDependencies {
  readonly lobby: CampaignLobbyService;
  readonly play: CampaignPlayController;
  readonly cards: CampaignCardService;
  readonly unitOfWork: CampaignUnitOfWork;
  readonly rulesets: RulesetCatalog;
  readonly adventures: AdventureLibrary;
  readonly glossaries: Readonly<Record<string, Glossary>>;
  // Saved characters: without it the hero picker offers only the adventure's presets.
  readonly library?: CharacterLibrary;
  // A hero's portrait for the full-size picture on their sheet; without it the sheet is text only.
  readonly pictures?: HeroPictures;
}

const maxActionLength = 500;
const actionField = "action";

type TurnInteraction = ButtonInteraction | StringSelectMenuInteraction;

// The engine command for a picked action; null when a target it needs is missing.
function combatCommand(choice: TurnChoice, targetIds: readonly string[]): ((combatantId: CharacterId) => CombatCommand) | null {
  const first = targetIds[0];
  switch (choice.kind) {
    case "attack":
      return first === undefined ? null : (combatantId): CombatCommand => ({ kind: "combatAttack", combatantId, targetId: first, weapon: choice.weapon as ContentId<"item"> });
    case "cast":
      return targetIds.length === 0 ? null : (combatantId): CombatCommand => ({ kind: "combatCast", combatantId, spellId: choice.spell as ContentId<"spell">, slotLevel: choice.slot, targetIds });
    case "engage":
      return first === undefined ? null : (combatantId): CombatCommand => ({ kind: "combatEngage", combatantId, targetId: first });
    case "feature":
      return (combatantId): CombatCommand => ({ kind: "combatUseFeature", combatantId, featureId: choice.feature as ContentId<"feature"> });
    case "potion":
      return (combatantId): CombatCommand => ({ kind: "combatUseItem", combatantId, itemId: choice.item as ContentId<"item"> });
    case "move":
      return (combatantId): CombatCommand => ({ kind: "combatMove", combatantId, zoneId: choice.zone });
    case "shield":
      return (combatantId): CombatCommand => ({ kind: "combatShield", combatantId, itemId: choice.item as ContentId<"item">, on: choice.on });
    case "withdraw":
      return (combatantId): CombatCommand => ({ kind: "combatWithdraw", combatantId });
    case "dodge":
      return (combatantId): CombatCommand => ({ kind: "combatDodge", combatantId });
    case "dash":
      return (combatantId): CombatCommand => ({ kind: "combatDash", combatantId });
    case "disengage":
      return (combatantId): CombatCommand => ({ kind: "combatDisengage", combatantId });
    case "end":
      return (combatantId): CombatCommand => ({ kind: "endTurn", combatantId });
    case "shape":
      return (combatantId): CombatCommand => ({ kind: "combatWildShape", combatantId, monsterId: choice.monster as ContentId<"monster"> });
    case "unshape":
      return (combatantId): CombatCommand => ({ kind: "combatWildShape", combatantId });
    case "spells":
    case "shapes":
      return null;
  }
}

// Which saved card a control must sit on to count as current. A control on any
// other message (an old panel, a copied link) is obsolete and only gets a
// private pointer to the newest message; it never opens a new gameplay flow.
function currentCards(action: CampaignAction, argument: string | null): readonly string[] {
  switch (action) {
    case "join":
    case "leave":
    case "pickHero":
    case "start":
    case "rules":
      return ["lobby"];
    case "act":
    case "pass":
    case "roll":
    case "away":
    case "back":
    case "continue":
    case "ready":
    case "begin":
    case "turn":
    case "speak":
    case "safety":
    case "more":
    case "explore":
      return ["adventure"];
    case "offerYes":
    case "offerNo":
    case "offerCancel":
      // An offer's buttons sit on that offer's own card.
      return [argument ?? ""];
    case "endTurn":
      // The confirmation button lives in a private message; the panel's own is the shared one.
      return argument === "yes" ? [] : ["adventure"];
    case "myHero":
      return ["adventure", "party"];
    case "details":
      return [`hero:${argument ?? ""}`];
    case "heroChoice":
    case "newHero":
    case "gear":
    case "turnRefresh":
    case "pick":
    case "aim":
    case "pack":
    case "giveTo":
    case "safetyPause":
    case "rulePreset":
    case "ruleOption":
    case "ruleValue":
    case "asiPick":
    case "levelClass":
    case "levelSkill":
    case "useSaved":
    case "saveProgress":
    case "journal":
    case "recap":
    case "proxy":
    case "levelOpen":
    case "exploreHome":
    case "exploreBack":
    case "exploreNpc":
    case "exploreAsk":
    case "exploreAskSubmit":
    case "explorePress":
    case "explorePressPick":
    case "exploreShop":
    case "exploreBuy":
    case "exploreSell":
    case "exploreHaggle":
    case "exploreCast":
    case "exploreCastPick":
    case "exploreHealSlot":
    case "exploreHealWho":
      return [];
    case "reactCast":
    case "reactDecline":
      // The one reaction window open at a time sits on its own card.
      return ["reaction"];
    case "smiteChoose":
    case "smiteSkip":
      // The one smite window open at a time sits on its own card.
      return ["smite"];
    case "opportunityTake":
    case "opportunityHold":
      // The one opportunity-attack window open at a time sits on its own card.
      return ["opportunity"];
  }
}

// Every campaign button, hero picker, and form. IDs carry no authority: each
// click loads the saved campaign, checks the message is current, and sends the
// change through the play controller or lobby service, which check membership,
// ownership, and organizer rights. Replies are private and in the campaign's language.
export class CampaignComponentHandler implements ComponentHandler {
  public readonly customIdPrefix = campaignIdPrefix;
  public readonly module = CommandModule.Campaign;
  public readonly access = publicAccessPolicy;

  private readonly explore: ExploreFlow;

  public constructor(private readonly deps: CampaignComponentDependencies) {
    this.explore = new ExploreFlow({ play: deps.play, unitOfWork: deps.unitOfWork, rulesets: deps.rulesets, adventures: deps.adventures, glossaries: deps.glossaries });
  }

  public async execute(context: ComponentContext): Promise<void> {
    const { interaction } = context;
    const parsed = parseCampaignId(interaction.customId);
    if (parsed === null || interaction.guildId === null) return;
    const key: CampaignKey = { guildId: interaction.guildId, campaignId: parsed.campaignId };
    const stored = await this.deps.lobby.get(key);
    if (stored === undefined) {
      await interaction.reply({ content: texts.en.campaign.refusal.notFound, flags: MessageFlags.Ephemeral });
      return;
    }
    const { record } = stored;
    const text = texts[record.language];

    if (interaction.isStringSelectMenu()) {
      if (parsed.action === "newHero") await this.joinReplacement(interaction, record, text);
      else if (parsed.action === "gear") await this.changeGear(interaction, record, text);
      else if (parsed.action === "pack") await this.changePack(interaction, record, text);
      else if (parsed.action === "giveTo") await this.giveItem(interaction, record, text);
      else if (parsed.action === "pick") await this.pickTurnAction(interaction, record, text);
      else if (parsed.action === "aim") await this.aimTurnAction(interaction, record, text);
      else if (parsed.action === "proxy") await this.changeProxy(interaction, record, text);
      else if (parsed.action === "asiPick") await this.chooseAsi(interaction, record, text);
      else if (parsed.action === "levelClass" || parsed.action === "levelSkill") await this.chooseClass(interaction, record, text, parsed.action, parsed.argument);
      else if (isExploreAction(parsed.action)) {
        await interaction.deferUpdate();
        await this.explore.select(interaction, record, text, parsed.action, parsed.argument);
      }
      else if (parsed.action === "rulePreset" || parsed.action === "ruleOption" || parsed.action === "ruleValue") await this.changeRules(interaction, record, text, parsed.action, parsed.argument);
      else await this.chooseHero(interaction, record, text);
      return;
    }
    if (!interaction.isButton()) return;
    const cards = currentCards(parsed.action, parsed.argument);
    if (cards.length > 0 && !cards.some((card) => CampaignCardService.isCurrent(record, card, interaction.message.id))) {
      await interaction.reply({ content: text.campaign.reply.obsolete, flags: MessageFlags.Ephemeral });
      this.deps.cards.refresh(key);
      return;
    }

    // A form must be the first response; everything else acknowledges first so a slow step never expires the click.
    if (parsed.action === "act") {
      const open = await this.deps.unitOfWork.transaction((tx) => tx.loadCampaign(key));
      await interaction.showModal(this.actionModal(record, text, open?.state.round?.number));
      return;
    }
    if (parsed.action === "speak") {
      await interaction.showModal(this.speakModal(record, text));
      return;
    }
    // Between fights: asking is a form, which has to be the first response; the other screens update their own message.
    if (parsed.action === "exploreAsk") {
      await interaction.showModal(this.explore.askModal(record, text, parsed.argument ?? ""));
      return;
    }
    if (isExploreAction(parsed.action) && parsed.action !== "explore") {
      await interaction.deferUpdate();
      await this.explore.button(interaction, record, text, parsed.action, parsed.argument);
      return;
    }
    // Buttons inside a private turn menu update that message instead of opening another.
    if (parsed.action === "turnRefresh") {
      await interaction.deferUpdate();
      await this.showTurn(interaction, record, text, null);
      return;
    }
    if (parsed.action === "safetyPause") {
      await interaction.deferUpdate();
      const result = await this.deps.play.safety(key, interaction.user.id, interaction.id);
      await interaction.editReply({ content: result.kind === "ok" ? text.campaign.reply.safetyDone : refusalText(text, result.reason), components: [] });
      return;
    }
    if (parsed.action === "endTurn" && parsed.argument === "yes") {
      await interaction.deferUpdate();
      await this.finishTurn(interaction, record, text);
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reply = (content: string): Promise<unknown> => interaction.editReply({ content, components: [] });
    const userId = interaction.user.id;
    switch (parsed.action) {
      case "join": {
        const joined = await this.deps.lobby.join(key, userId);
        if (joined.kind === "refused") return void (await reply(refusalText(text, joined.reason)));
        this.deps.cards.refresh(key);
        await this.showHeroPicker(interaction, record, text, text.campaign.reply.joined({ name: record.name }));
        return;
      }
      case "pickHero":
        await this.showHeroPicker(interaction, record, text, text.campaign.pick.prompt);
        return;
      case "leave": {
        const left = await this.deps.lobby.leave(key, userId);
        if (left.kind === "refused") return void (await reply(refusalText(text, left.reason)));
        this.deps.cards.refresh(key);
        await reply(text.campaign.reply.left);
        return;
      }
      case "start": {
        const started = await this.deps.lobby.start(key, userId);
        if (started.kind === "refused") return void (await reply(refusalText(text, started.reason)));
        await this.deps.cards.sync(key);
        await reply(text.campaign.reply.started);
        return;
      }
      case "pass":
        return void (await this.outcome(await this.deps.play.pass(key, userId, interaction.id), text.campaign.reply.passed, reply, text));
      case "roll":
        return void (await this.outcome(await this.deps.play.roll(key, userId, interaction.id), text.campaign.reply.rolled, reply, text));
      case "away":
        return void (await this.outcome(await this.deps.play.away(key, userId, interaction.id), text.campaign.reply.away, reply, text));
      case "back": {
        const returned = await this.deps.play.back(key, userId, interaction.id);
        // Someone coming back is caught up on what they missed.
        return void (await reply(returned.kind === "ok" ? `${text.campaign.reply.back}\n\n${await this.recapText(record, text)}` : refusalText(text, returned.reason)));
      }
      case "journal":
        return void (await reply(await this.journalText(record, text)));
      case "recap":
        return void (await reply(await this.recapText(record, text)));
      case "continue":
        return void (await this.outcome(await this.deps.play.continue(key, userId, interaction.id), text.campaign.reply.continued, reply, text));
      case "ready":
        return void (await this.outcome(await this.deps.play.ready(key, userId, interaction.id), text.campaign.reply.ready, reply, text));
      case "begin":
        return void (await this.outcome(await this.deps.play.begin(key, userId, interaction.id), text.campaign.reply.began, reply, text));
      case "offerYes":
      case "offerNo":
      case "offerCancel": {
        const answer = parsed.action === "offerYes" ? "accept" : parsed.action === "offerNo" ? "decline" : "cancel";
        const said = answer === "accept" ? text.campaign.reply.offerAccepted : answer === "decline" ? text.campaign.reply.offerDeclined : text.campaign.reply.offerCancelled;
        return void (await this.outcome(await this.deps.play.answerOffer(key, userId, parsed.argument ?? "", answer, interaction.id), said, reply, text));
      }
      case "reactCast":
      case "reactDecline": {
        const spellId = parsed.action === "reactCast" ? (parsed.argument as ContentId<"spell"> | null) : null;
        const said = spellId === null ? text.campaign.reply.reactionDeclined : text.campaign.reply.reactionCast;
        const command = (combatantId: CharacterId): CombatCommand => ({ kind: "combatReact", combatantId, spellId });
        return void (await this.outcome(await this.deps.play.combat(key, userId, interaction.id, command), said, reply, text));
      }
      case "smiteChoose":
      case "smiteSkip": {
        const slotLevel = parsed.action === "smiteChoose" ? Number(parsed.argument) : null;
        const said = slotLevel === null ? text.campaign.reply.smiteSkipped : text.campaign.reply.smiteChosen;
        const command = (combatantId: CharacterId): CombatCommand => ({ kind: "combatSmite", combatantId, slotLevel });
        return void (await this.outcome(await this.deps.play.combat(key, userId, interaction.id, command), said, reply, text));
      }
      case "opportunityTake":
      case "opportunityHold": {
        const take = parsed.action === "opportunityTake";
        const said = take ? text.campaign.reply.opportunityTaken : text.campaign.reply.opportunityHeld;
        const command = (combatantId: CharacterId): CombatCommand => ({ kind: "combatOpportunityAttack", combatantId, take });
        return void (await this.outcome(await this.deps.play.combat(key, userId, interaction.id, command), said, reply, text));
      }
      case "useSaved": {
        const chosen = await this.deps.lobby.chooseSaved(key, userId, parsed.argument ?? "");
        if (chosen.kind === "conflicts") {
          return void (await reply([text.campaign.chars.previewConflicts, ...conflictLines(chosen.conflicts, text).map((line) => `• ${line}`)].join("\n")));
        }
        if (chosen.kind === "refused") return void (await reply(refusalText(text, chosen.reason)));
        this.deps.cards.refresh(key);
        const label = chosen.value.lobby.members.find((member) => member.userId === userId)?.label;
        return void (await reply(text.campaign.chars.chosen({ hero: label?.name ?? "" })));
      }
      case "saveProgress":
        return void (await reply(await this.saveProgress(record, userId, text)));
      case "levelOpen": {
        const form = await this.levelForm(record, text, userId);
        if (form === null) return void (await reply(refusalText(text, "noHero")));
        await interaction.editReply(form);
        return;
      }
      case "explore":
        return void (await this.explore.open(interaction, record, text));
      case "safety":
        await interaction.editReply({
          content: text.campaign.reply.safetyAsk,
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(campaignCustomId("safetyPause", key.campaignId)).setLabel(text.campaign.button.pauseGame).setStyle(ButtonStyle.Danger),
            ),
          ],
        });
        return;
      case "more":
        await interaction.editReply({
          content: `${text.campaign.more.help}\n\n**${text.campaign.rules.title}**\n${ruleLines(text, record.houseRules).join("\n")}`,
          components: [this.storyRow(record, text), ...this.linkRow(record, text)],
        });
        return;
      case "rules":
        await interaction.editReply(renderRulesScreen({ campaignId: key.campaignId, houseRules: record.houseRules, editable: record.lifecycle === "lobby" && record.organizerId === userId, selected: null, text }));
        return;
      case "turn":
        await this.showTurn(interaction, record, text, null);
        return;
      case "endTurn":
        await this.requestEndTurn(interaction, record, text);
        return;
      case "myHero":
      case "details": {
        // A player whose hero fell is offered a new one instead of a sheet.
        const options = parsed.action === "myHero" ? await this.deps.play.replacementOptions(key, userId) : [];
        if (options.length > 0) {
          await this.showReplacementPicker(interaction, record, text, options);
          return;
        }
        const sheet = await this.heroSheet(record, text, parsed.action === "details" ? parsed.argument : null, userId);
        // Only the player's own hero gets the gear controls.
        const gear = parsed.action === "myHero" ? await this.heroMenus(record, text, userId) : [];
        const save = parsed.action === "myHero" ? await this.saveRow(record, text, userId) : [];
        const asi = parsed.action === "myHero" ? await this.levelRow(record, text, userId) : [];
        const proxy = parsed.action === "myHero" ? await this.proxyMenu(record, text, userId) : [];
        const portrait = await this.heroPortrait(record, parsed.action === "details" ? parsed.argument : null, userId);
        await interaction.editReply({ content: sheet, components: [...gear, ...asi, ...proxy, ...save].slice(0, 5), ...(portrait === undefined ? {} : { files: [portrait] }) });
        return;
      }
      default:
        return;
    }
  }

  public async executeModal(context: ModalContext): Promise<void> {
    const { interaction } = context;
    const parsed = parseCampaignId(interaction.customId);
    if ((parsed?.action !== "act" && parsed?.action !== "speak" && parsed?.action !== "exploreAskSubmit") || interaction.guildId === null) return;
    const key: CampaignKey = { guildId: interaction.guildId, campaignId: parsed.campaignId };
    const stored = await this.deps.lobby.get(key);
    const text = texts[stored?.record.language ?? "en"];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (parsed.action === "exploreAskSubmit") {
      if (stored === undefined) return void (await interaction.editReply({ content: text.campaign.refusal.notFound }));
      await this.explore.submitAsk(interaction, stored.record, text, parsed.argument ?? "");
      return;
    }
    if (parsed.action === "speak") {
      const spoke = await this.deps.play.speak(key, interaction.user.id, this.field(interaction), interaction.id);
      await interaction.editReply({ content: spoke.kind === "ok" ? text.campaign.reply.spoke : refusalText(text, spoke.reason) });
      return;
    }
    const forRound = parsed.argument === null ? Number.NaN : Number(parsed.argument);
    const result = await this.deps.play.submitAction(key, interaction.user.id, this.field(interaction), interaction.id, Number.isInteger(forRound) ? forRound : undefined);
    await interaction.editReply({ content: result.kind === "ok" ? text.campaign.reply.actionSaved : refusalText(text, result.reason) });
  }

  // A link to the Party post, the place a player may want to go back to.
  private linkRow(record: CampaignRecord, text: Texts): ActionRowBuilder<ButtonBuilder>[] {
    const url = (channelId: string | null): string | null => (channelId === null ? null : `https://discord.com/channels/${record.key.guildId}/${channelId}`);
    const link = (label: string, target: string | null): ButtonBuilder[] =>
      target === null ? [] : [new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel(label).setURL(target)];
    const buttons = link(text.campaign.button.partyChannel, url(record.channels.partyPostId));
    return buttons.length === 0 ? [] : [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)];
  }

  private speakModal(record: CampaignRecord, text: Texts): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(campaignCustomId("speak", record.key.campaignId))
      .setTitle(text.campaign.speak.title)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(actionField)
            .setLabel(text.campaign.speak.label)
            .setPlaceholder(text.campaign.speak.placeholder)
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(maxSpeechLength)
            .setRequired(true),
        ),
      );
  }

  private field(interaction: ModalSubmitInteraction): string {
    return interaction.fields.getTextInputValue(actionField).trim();
  }

  private async outcome(result: PlayResult, success: string, reply: (content: string) => Promise<unknown>, text: Texts): Promise<void> {
    await reply(result.kind === "ok" ? success : refusalText(text, result.reason));
  }

  private actionModal(record: CampaignRecord, text: Texts, roundNumber: number | undefined): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(roundNumber === undefined ? campaignCustomId("act", record.key.campaignId) : campaignCustomId("act", record.key.campaignId, String(roundNumber)))
      .setTitle(text.campaign.modal.title)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId(actionField)
            .setLabel(text.campaign.modal.label)
            .setPlaceholder(text.campaign.modal.placeholder)
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(maxActionLength)
            .setRequired(true),
        ),
      );
  }

  // The free heroes, plus the one this player already holds so they can keep or change it.
  private async showHeroPicker(interaction: ButtonInteraction, record: CampaignRecord, text: Texts, prompt: string): Promise<void> {
    const document = this.deps.adventures.document(record.adventure.adventureId, record.language);
    const stored = await this.deps.lobby.get(record.key);
    const lobby = (stored?.record ?? record).lobby;
    const own = lobby.members.find((member) => member.userId === interaction.user.id)?.heroId ?? null;
    const heroes = document?.heroes ?? [];
    const available = new Set([...freeHeroes(lobby, heroes.map((hero) => hero.id)), ...(own === null ? [] : [own])]);
    const presetOptions = heroes.filter((hero) => available.has(hero.id)).map((hero) => ({ label: text.campaign.pick.option({ hero: hero.name, class: classLabel(text, hero.class) }).slice(0, 100), value: hero.id, default: hero.id === own }));
    // The player's saved characters come after the adventure's own heroes.
    const saved = this.deps.library === undefined ? [] : await this.savedOptions(interaction.user.id, text, own);
    const options = [...presetOptions, ...saved].slice(0, 25);
    if (options.length === 0) {
      await interaction.editReply({ content: text.campaign.pick.none, components: [] });
      return;
    }
    await interaction.editReply({
      content: prompt,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder().setCustomId(campaignCustomId("heroChoice", record.key.campaignId)).setPlaceholder(text.campaign.pick.prompt).addOptions(options),
        ),
      ],
    });
  }

  private async showReplacementPicker(
    interaction: ButtonInteraction,
    record: CampaignRecord,
    text: Texts,
    options: readonly { readonly id: string; readonly name: string; readonly className: string }[],
  ): Promise<void> {
    await interaction.editReply({
      content: text.campaign.reply.fallen,
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(campaignCustomId("newHero", record.key.campaignId))
            .setPlaceholder(text.campaign.pick.prompt)
            .addOptions(options.map((option) => ({ label: text.campaign.pick.option({ hero: option.name, class: classLabel(text, option.className) }).slice(0, 100), value: option.id }))),
        ),
      ],
    });
  }

  private async joinReplacement(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts): Promise<void> {
    const presetId = interaction.values[0] ?? "";
    const result = await this.deps.play.joinHero(record.key, interaction.user.id, presetId, interaction.id);
    if (result.kind === "refused") {
      await interaction.update({ content: refusalText(text, result.reason), components: [] });
      return;
    }
    const hero = this.deps.adventures.document(record.adventure.adventureId, record.language)?.heroes.find((candidate) => candidate.id === presetId);
    await interaction.update({ content: text.campaign.reply.newHero({ hero: hero?.name ?? presetId }), components: [] });
  }

  // Every saved version of the player's characters, newest first, as picker options.
  private async savedOptions(userId: string, text: Texts, own: string | null): Promise<{ label: string; value: string; default: boolean }[]> {
    const entries = (await this.deps.library?.list(userId)) ?? [];
    return entries.flatMap((entry) =>
      [...entry.snapshots].reverse().map((snapshot) => {
        const value = libraryHeroRef(snapshot.id);
        return {
          label: text.campaign.chars.savedOption({ name: entry.character.name, class: classLabel(text, entry.character.className), revision: snapshot.revision }).slice(0, 100),
          value,
          default: value === own,
        };
      }),
    );
  }

  // What a saved character would bring, and what stands in the way, before they are seated.
  private async previewSaved(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts, snapshotId: string): Promise<void> {
    await interaction.deferUpdate();
    const preview = await this.deps.lobby.previewSaved(record.key, interaction.user.id, snapshotId);
    if (preview.kind === "refused") {
      await interaction.editReply({ content: refusalText(text, preview.reason), components: [] });
      return;
    }
    const t = text.campaign.chars;
    const glossary = this.deps.glossaries[record.language];
    const hero = preview.hero;
    const lines = hero === null ? [] : [t.previewTitle({ name: hero.name, class: classLabel(text, hero.className ?? ""), level: hero.level }), t.previewLine({ hp: hero.maxHp, gear: hero.equipment.map((id) => glossary?.names[id] ?? id).join(", ") })];
    if (preview.conflicts.length > 0) {
      await interaction.editReply({ content: [...lines, "", t.previewConflicts, ...conflictLines(preview.conflicts, text).map((line) => `• ${line}`)].join("\n"), components: [] });
      return;
    }
    await interaction.editReply({
      content: [...lines, "", t.previewOk].join("\n"),
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(campaignCustomId("useSaved", record.key.campaignId, snapshotId)).setLabel(t.useButton).setStyle(ButtonStyle.Success))],
    });
  }

  // Saves the hero's progress back to the player's library.
  private async saveProgress(record: CampaignRecord, userId: string, text: Texts): Promise<string> {
    const t = text.campaign.chars;
    const library = this.deps.library;
    if (library === undefined) return refusalText(text, "libraryUnavailable");
    const result = await library.saveProgress(userId, record.key);
    if (result.kind === "refused") return (t.saveRefused as Readonly<Record<string, string>>)[result.reason] ?? text.campaign.refusal.generic;
    if (!result.created) return t.progressAlready;
    return t.progressSaved({ name: result.snapshot.build.name, revision: result.snapshot.revision });
  }

  private async chooseHero(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts): Promise<void> {
    const heroId = interaction.values[0] ?? "";
    const savedId = savedSnapshotIdOf(heroId);
    if (savedId !== null) {
      await this.previewSaved(interaction, record, text, savedId);
      return;
    }
    const result = await this.deps.lobby.chooseHero(record.key, interaction.user.id, heroId);
    if (result.kind === "refused") {
      await interaction.update({ content: refusalText(text, result.reason), components: [] });
      return;
    }
    this.deps.cards.refresh(record.key);
    const hero = this.deps.adventures.document(record.adventure.adventureId, record.language)?.heroes.find((candidate) => candidate.id === heroId);
    await interaction.update({ content: text.campaign.reply.heroChosen({ hero: hero?.name ?? heroId }), components: [] });
  }

  // The clicker's turn, ready to plan: their hero's turn view, or a private
  // explanation of why there is none (not in a fight, or someone else's turn).
  private async turnContext(record: CampaignRecord, text: Texts, userId: string): Promise<{ readonly kind: "ready"; readonly view: TurnView; readonly glossary: Glossary } | { readonly kind: "message"; readonly content: string }> {
    const loaded = await this.deps.unitOfWork.transaction((tx) => tx.loadCampaign(record.key));
    const glossary = this.deps.glossaries[record.language];
    const bible = this.deps.adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
    if (loaded === undefined || glossary === undefined || bible === undefined) return { kind: "message", content: text.campaign.refusal.notActive };
    const { state } = loaded;
    const encounter = state.encounter;
    // A player an away friend named plays that friend's hero on its turn (the controls act as the same hero).
    const heroId = actingHero(state, userId);
    if (heroId === null) return { kind: "message", content: text.campaign.refusal.noHero };
    if (encounter === null || encounter.status !== "active") return { kind: "message", content: text.campaign.refusal.notInCombat };
    const { content, houseRules } = this.deps.rulesets.resolve(loaded.ruleset);
    const view = buildTurnView(state, content, houseRules, { state, bible, glossary }, heroId);
    if (view !== null) return { kind: "ready", view, glossary };
    const current = encounter.combatants[encounter.order[encounter.turnIndex] ?? ""];
    const name = current === undefined ? "" : combatantName(current, { state, bible, glossary });
    return { kind: "message", content: heroId === current?.id ? text.campaign.turn.over : text.campaign.turn.notYours({ name }) };
  }

  private async showTurn(interaction: TurnInteraction, record: CampaignRecord, text: Texts, notice: string | null): Promise<void> {
    const context = await this.turnContext(record, text, interaction.user.id);
    if (context.kind === "message") {
      await interaction.editReply({ content: notice === null ? context.content : `${notice}\n\n${context.content}`, components: [] });
      return;
    }
    const menu = renderTurnMenu(context.view, text, context.glossary, record.key.campaignId);
    await this.editMenu(interaction, menu, notice);
  }

  private async editMenu(interaction: TurnInteraction, menu: TurnMenu, notice: string | null): Promise<void> {
    await interaction.editReply({ content: notice === null ? menu.content : `${notice}\n\n${menu.content}`, components: menu.components });
  }

  // Step one: an action is picked. Aimed actions ask for targets next.
  private async pickTurnAction(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts): Promise<void> {
    await interaction.deferUpdate();
    const choice = parseChoice(interaction.values[0] ?? "");
    if (choice === null) {
      await this.showTurn(interaction, record, text, text.campaign.refusal.generic);
      return;
    }
    if (choice.kind === "end") {
      await this.requestEndTurn(interaction, record, text);
      return;
    }
    const context = await this.turnContext(record, text, interaction.user.id);
    if (context.kind === "message") {
      await interaction.editReply({ content: context.content, components: [] });
      return;
    }
    if (choice.kind === "spells") {
      await this.editMenu(interaction, renderSpellMenu(context.view, choice.page, text, context.glossary, record.key.campaignId), null);
      return;
    }
    if (choice.kind === "shapes") {
      await this.editMenu(interaction, renderShapeMenu(context.view, choice.page, text, context.glossary, record.key.campaignId), null);
      return;
    }
    const aimed = choice.kind === "attack" || choice.kind === "cast" || choice.kind === "engage";
    if (!aimed) {
      await this.runChoice(interaction, record, text, choice, []);
      return;
    }
    const menu = renderTargetMenu(choice, context.view, text, context.glossary, record.key.campaignId);
    // The menu went stale (no target left): show the fresh one.
    if (menu === null) await this.showTurn(interaction, record, text, text.campaign.refusal.invalidTarget);
    else await this.editMenu(interaction, menu, null);
  }

  // Step two: the targets are picked and the action happens.
  private async aimTurnAction(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts): Promise<void> {
    await interaction.deferUpdate();
    const aims = interaction.values.map((value) => parseAim(value));
    const first = aims[0];
    if (first === null || first === undefined || aims.some((aim) => aim === null || encodeChoice(aim.choice) !== encodeChoice(first.choice))) {
      await this.showTurn(interaction, record, text, text.campaign.refusal.generic);
      return;
    }
    await this.runChoice(interaction, record, text, first.choice, aims.flatMap((aim) => (aim === null ? [] : [aim.targetId])));
  }

  private async runChoice(interaction: TurnInteraction, record: CampaignRecord, text: Texts, choice: TurnChoice, targetIds: readonly string[]): Promise<void> {
    const command = combatCommand(choice, targetIds);
    if (command === null) {
      await this.showTurn(interaction, record, text, text.campaign.refusal.generic);
      return;
    }
    const result = await this.deps.play.combat(record.key, interaction.user.id, interaction.id, command);
    await this.showTurn(interaction, record, text, result.kind === "ok" ? text.campaign.reply.turnDone : refusalText(text, result.reason));
  }

  // End turn: with something still to spend, the player confirms first.
  private async requestEndTurn(interaction: TurnInteraction, record: CampaignRecord, text: Texts): Promise<void> {
    const context = await this.turnContext(record, text, interaction.user.id);
    if (context.kind === "message") {
      await interaction.editReply({ content: context.content, components: [] });
      return;
    }
    if (context.view.hasUnspent && !context.view.busy) await this.editMenu(interaction, renderEndConfirm(text, record.key.campaignId), null);
    else await this.finishTurn(interaction, record, text);
  }

  private async finishTurn(interaction: TurnInteraction, record: CampaignRecord, text: Texts): Promise<void> {
    const result = await this.deps.play.combat(record.key, interaction.user.id, interaction.id, (combatantId): CombatCommand => ({ kind: "endTurn", combatantId }));
    await interaction.editReply({ content: result.kind === "ok" ? text.campaign.reply.turnEnded : refusalText(text, result.reason), components: [] });
  }

  // The sheet of the clicker's own hero (My Hero) or a named one (Details on a hero card).
  // A menu of the armor and shields the player's hero carries: put on what is
  // off, take off what is worn. Empty when the hero has none.
  private async gearControls(record: CampaignRecord, text: Texts, userId: string): Promise<ActionRowBuilder<StringSelectMenuBuilder>[]> {
    const loaded = await this.deps.unitOfWork.transaction((tx) => tx.loadCampaign(record.key));
    const heroId = loaded?.state.members[userId]?.characterId ?? null;
    const sheet = heroId === null ? undefined : loaded?.state.characters[heroId];
    const glossary = this.deps.glossaries[record.language];
    if (loaded === undefined || sheet === undefined || glossary === undefined || isFallen(loaded.state, sheet.id)) return [];
    const content = this.deps.rulesets.resolve(loaded.ruleset).content;
    const options = sheet.equipment.flatMap((id) => {
      const definition = content.find(id);
      if (definition?.kind !== "item" || (definition.itemType !== "armor" && definition.itemType !== "shield")) return [];
      const name = glossary.names[id] ?? id;
      const worn = isWorn(sheet, content, id);
      return [{ label: (worn ? text.campaign.gear.remove({ item: name }) : text.campaign.gear.wear({ item: name })).slice(0, 100), value: `${worn ? "remove" : "wear"}|${id}` }];
    });
    // The same item twice would repeat an option value.
    const unique = options.filter((option, index) => options.findIndex((other) => other.value === option.value) === index);
    if (unique.length === 0) return [];
    return [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(campaignCustomId("gear", record.key.campaignId)).setPlaceholder(text.campaign.gear.placeholder).addOptions(unique),
      ),
    ];
  }

  private async changeGear(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts): Promise<void> {
    await interaction.deferUpdate();
    const [verb, itemId] = (interaction.values[0] ?? "").split("|");
    const item = typeof itemId === "string" && itemId.startsWith("item:") ? (itemId as ContentId<"item">) : null;
    if (item === null || (verb !== "wear" && verb !== "remove")) {
      await interaction.editReply({ content: text.campaign.refusal.generic, components: [] });
      return;
    }
    const result = verb === "wear"
      ? await this.deps.play.wear(record.key, interaction.user.id, item, interaction.id)
      : await this.deps.play.remove(record.key, interaction.user.id, item, interaction.id);
    if (result.kind !== "ok") {
      await interaction.editReply({ content: refusalText(text, result.reason), components: [] });
      return;
    }
    // Show the sheet again, with the menu updated for what is worn now.
    await interaction.editReply({
      content: `${text.campaign.reply.gearChanged}\n\n${await this.heroSheet(record, text, null, interaction.user.id)}`,
      components: await this.heroMenus(record, text, interaction.user.id),
    });
  }

  private storyRow(record: CampaignRecord, text: Texts): ActionRowBuilder<ButtonBuilder> {
    const id = record.key.campaignId;
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(campaignCustomId("journal", id)).setLabel(text.campaign.button.journal).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(campaignCustomId("recap", id)).setLabel(text.campaign.button.recap).setStyle(ButtonStyle.Secondary),
    );
  }

  private async story(record: CampaignRecord): Promise<{ state: CampaignState; events: readonly CampaignEvent[]; bible: AdventureBible } | null> {
    const loaded = await this.deps.unitOfWork.transaction(async (tx) => ({ stored: await tx.loadCampaign(record.key), envelopes: await tx.readEvents(record.key) }));
    const bible = this.deps.adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
    if (loaded.stored === undefined || bible === undefined) return null;
    return { state: loaded.stored.state, events: loaded.envelopes.map((envelope) => envelope.event), bible };
  }

  // The public journal: chapters, people and places remembered, clues found.
  private async journalText(record: CampaignRecord, text: Texts): Promise<string> {
    const t = text.campaign.journal;
    const story = await this.story(record);
    if (story === null) return t.empty;
    const journal = buildJournal(story.state, story.bible);
    const lines = [`**${t.title}**`, journal.sceneTitle === null ? "" : t.where({ scene: journal.sceneTitle })].filter((line) => line !== "");
    if (journal.chapters.length > 0) lines.push("", t.chapters, ...journal.chapters.map((chapter) => t.chapter({ from: chapter.fromRound, through: chapter.throughRound, text: chapter.text })));
    if (journal.people.length > 0) lines.push("", t.people, ...journal.people.map((person) => `• **${person.name}:** ${person.facts.join(" ")}`));
    if (journal.clues.length > 0) lines.push("", t.clues, ...journal.clues.map((clue) => `• ${clue}`));
    if (journal.chapters.length === 0 && journal.people.length === 0 && journal.clues.length === 0) lines.push("", t.nothingYet);
    return fit(lines, 1900);
  }

  // A catch-up: where the party is, the latest chapter, the last things told.
  private async recapText(record: CampaignRecord, text: Texts): Promise<string> {
    const t = text.campaign.journal;
    const story = await this.story(record);
    if (story === null) return t.empty;
    const recap = buildRecap(story.state, story.events, story.bible);
    const lines = [`**${t.recapTitle}**`, recap.sceneTitle === null ? "" : t.where({ scene: recap.sceneTitle })].filter((line) => line !== "");
    if (recap.latestChapter !== null) lines.push(recap.latestChapter);
    if (recap.recent.length > 0) lines.push("", t.lately, ...recap.recent.map((told) => `> ${told.replace(/\n+/g, " ")}`));
    if (recap.clues.length > 0) lines.push("", t.clues, ...recap.clues.map((clue) => `• ${clue}`));
    if (recap.latestChapter === null && recap.recent.length === 0) lines.push("", t.nothingYet);
    return fit(lines, 1900);
  }

  // Save progress, for a hero that came from the player's library.
  private async saveRow(record: CampaignRecord, text: Texts, userId: string): Promise<ActionRowBuilder<ButtonBuilder>[]> {
    if (this.deps.library === undefined) return [];
    const loaded = await this.deps.unitOfWork.transaction((tx) => tx.loadCampaign(record.key));
    const heroId = loaded?.state.members[userId]?.characterId ?? null;
    if (heroId === null || loaded?.state.characters[heroId]?.origin === undefined) return [];
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(campaignCustomId("saveProgress", record.key.campaignId)).setLabel(text.campaign.button.saveProgress).setStyle(ButtonStyle.Secondary)),
    ];
  }

  // Opens the level-up form, whenever the hero has a level to go or an Improvement owed.
  private async levelRow(record: CampaignRecord, text: Texts, userId: string): Promise<ActionRowBuilder<ButtonBuilder>[]> {
    const loaded = await this.deps.unitOfWork.transaction((tx) => tx.loadCampaign(record.key));
    const heroId = loaded?.state.members[userId]?.characterId ?? null;
    const sheet = heroId === null ? undefined : loaded?.state.characters[heroId];
    if (sheet === undefined || (sheet.level >= maxLevel && (sheet.pendingAsi ?? 0) <= 0)) return [];
    const owed = (sheet.pendingAsi ?? 0) > 0;
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(campaignCustomId("levelOpen", record.key.campaignId)).setLabel(text.campaign.button.levelUp).setStyle(owed ? ButtonStyle.Success : ButtonStyle.Secondary),
      ),
    ];
  }

  // The private level-up form for the player's own hero, or null when they have none.
  private async levelForm(record: CampaignRecord, text: Texts, userId: string, note?: string): Promise<{ readonly content: string; readonly components: ActionRowBuilder<StringSelectMenuBuilder>[] } | null> {
    const loaded = await this.deps.unitOfWork.transaction((tx) => tx.loadCampaign(record.key));
    const heroId = loaded?.state.members[userId]?.characterId ?? null;
    const sheet = heroId === null ? undefined : loaded?.state.characters[heroId];
    const glossary = this.deps.glossaries[record.language];
    if (loaded === undefined || sheet === undefined || glossary === undefined) return null;
    return renderLevelForm({ campaignId: record.key.campaignId, sheet, milestone: record.houseRules[levelingMode.id] === "milestone", text, glossary, ...(note === undefined ? {} : { note }) });
  }

  // The form's class and skill menus: declare which class the next level lands in.
  private async chooseClass(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts, action: "levelClass" | "levelSkill", argument: string | null): Promise<void> {
    await interaction.deferUpdate();
    const value = interaction.values[0] ?? "";
    const buildClass = action === "levelClass" ? value : argument ?? "";
    const result = await this.deps.play.chooseClassLevel(record.key, interaction.user.id, buildClass, action === "levelSkill" ? value : undefined, interaction.id);
    const note = result.kind === "ok" ? text.campaign.reply.classPlanned({ class: classLabel(text, buildClass) }) : refusalText(text, result.reason);
    const form = await this.levelForm(record, text, interaction.user.id, note);
    await interaction.editReply(form ?? { content: note, components: [] });
  }

  // "Let someone play my hero in fights while I am away": a menu of the other players on My Hero.
  private async proxyMenu(record: CampaignRecord, text: Texts, userId: string): Promise<ActionRowBuilder<StringSelectMenuBuilder>[]> {
    const loaded = await this.deps.unitOfWork.transaction((tx) => tx.loadCampaign(record.key));
    if (loaded === undefined || loaded.state.members[userId] === undefined) return [];
    const { state } = loaded;
    const others = Object.values(state.members).filter((member) => member.userId !== userId && member.characterId !== null);
    if (others.length === 0) return [];
    const t = text.campaign.proxy;
    const current = state.proxies?.[userId] ?? null;
    const options = [
      { label: t.nobody, value: "none", default: current === null },
      ...others.map((member) => ({ label: t.player({ hero: state.characters[member.characterId ?? ""]?.name ?? "" }).slice(0, 100), value: member.userId, default: member.userId === current })),
    ].slice(0, 25);
    return [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(campaignCustomId("proxy", record.key.campaignId)).setPlaceholder(t.placeholder).addOptions(options))];
  }

  private async changeProxy(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts): Promise<void> {
    await interaction.deferUpdate();
    const value = interaction.values[0] ?? "none";
    const result = await this.deps.play.proxy(record.key, interaction.user.id, value === "none" ? null : value, interaction.id);
    await interaction.editReply({ content: result.kind === "ok" ? (value === "none" ? text.campaign.proxy.cleared : text.campaign.proxy.set) : refusalText(text, result.reason), components: [] });
  }

  private async chooseAsi(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts): Promise<void> {
    await interaction.deferUpdate();
    const userId = interaction.user.id;
    const chosen = interaction.values.filter((value): value is Ability => (abilities as readonly string[]).includes(value));
    if (chosen.length === 0 || chosen.length > 2 || (chosen.length === 2 && chosen[0] === chosen[1])) {
      await interaction.editReply({ content: refusalText(text, "invalidAsiAllocation"), components: [] });
      return;
    }
    const [first, second] = chosen;
    if (first === undefined) return;
    const loaded = await this.deps.unitOfWork.transaction((tx) => tx.loadCampaign(record.key));
    const heroId = loaded?.state.members[userId]?.characterId ?? null;
    const before = heroId === null ? undefined : loaded?.state.characters[heroId]?.abilityScores;
    const allocation = second === undefined ? { plusTwo: first } : { plusOne: [first, second] as const };
    const result = await this.deps.play.chooseAsi(record.key, userId, allocation, interaction.id);
    if (result.kind !== "ok") {
      await interaction.editReply({ content: refusalText(text, result.reason), components: [] });
      return;
    }
    const changes = chosen
      .map((ability) => `${text.campaign.ability[ability]} ${before?.[ability] ?? 0} → ${Math.min(20, (before?.[ability] ?? 0) + (second === undefined ? 2 : 1))}`)
      .join(", ");
    const form = await this.levelForm(record, text, userId, text.campaign.reply.asiApplied({ changes }));
    if (form === null) await this.showHeroAgain(interaction, record, text, text.campaign.reply.asiApplied({ changes }));
    else await interaction.editReply(form);
  }

  // The Table rules screen's menus: pick a bundle, pick an option, or pick a
  // value. Only the organizer, only in the lobby (the service checks again).
  private async changeRules(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts, action: "rulePreset" | "ruleOption" | "ruleValue", argument: string | null): Promise<void> {
    await interaction.deferUpdate();
    const value = interaction.values[0] ?? "";
    const userId = interaction.user.id;
    let selected: string | null = action === "ruleOption" ? value : action === "ruleValue" ? argument : null;
    let latest = record;
    if (action !== "ruleOption") {
      const changes = action === "rulePreset" ? houseRulePresets.find((preset) => preset.id === value)?.values : argument === null ? undefined : { [argument]: value };
      const saved = changes === undefined ? null : await this.deps.lobby.setHouseRules(record.key, userId, changes);
      if (saved === null || saved.kind === "refused") {
        await interaction.editReply({ content: refusalText(text, saved?.reason ?? "generic"), components: [] });
        return;
      }
      latest = saved.value;
    }
    if (action === "rulePreset") selected = null;
    await interaction.editReply(renderRulesScreen({ campaignId: record.key.campaignId, houseRules: latest.houseRules, editable: latest.lifecycle === "lobby" && latest.organizerId === userId, selected, text }));
  }

  // Everything My Hero lets the player change: worn gear, then the pack.
  private async heroMenus(record: CampaignRecord, text: Texts, userId: string): Promise<ActionRowBuilder<StringSelectMenuBuilder>[]> {
    const gear = await this.gearControls(record, text, userId);
    const loaded = await this.deps.unitOfWork.transaction((tx) => tx.loadCampaign(record.key));
    const heroId = loaded?.state.members[userId]?.characterId ?? null;
    const glossary = this.deps.glossaries[record.language];
    if (loaded === undefined || heroId === null || glossary === undefined) return gear;
    const pack = packMenu(loaded.state, this.deps.rulesets.resolve(loaded.ruleset).content, glossary, text, record.key.campaignId, heroId, loaded.ruleset.houseRules["item-trading"] === "off");
    return pack === null ? gear : [...gear, pack];
  }

  // Drink, stash, or take: done at once. Giving asks who to give to next.
  private async changePack(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts): Promise<void> {
    await interaction.deferUpdate();
    const choice = parsePackChoice(interaction.values[0] ?? "");
    if (choice === null) {
      await interaction.editReply({ content: text.campaign.refusal.generic, components: [] });
      return;
    }
    if (choice.verb === "give") {
      const loaded = await this.deps.unitOfWork.transaction((tx) => tx.loadCampaign(record.key));
      const heroId = loaded?.state.members[interaction.user.id]?.characterId ?? null;
      const glossary = this.deps.glossaries[record.language];
      const menu = loaded === undefined || heroId === null || glossary === undefined ? null : giveMenu(loaded.state, glossary, text, record.key.campaignId, heroId, choice.item);
      await interaction.editReply(menu === null ? { content: text.campaign.refusal.generic, components: [] } : { content: menu.content, components: [menu.row] });
      return;
    }
    const { play } = this.deps;
    const user = interaction.user.id;
    const result =
      choice.verb === "use"
        ? await play.useItem(record.key, user, choice.item, interaction.id)
        : choice.verb === "stash"
          ? await play.stash(record.key, user, choice.item, interaction.id)
          : await play.takeFromStash(record.key, user, choice.item, interaction.id);
    await this.showHeroAgain(interaction, record, text, result.kind === "ok" ? text.campaign.reply.packDone : refusalText(text, result.reason));
  }

  private async giveItem(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts): Promise<void> {
    await interaction.deferUpdate();
    const gift = parseGift(interaction.values[0] ?? "");
    if (gift === null) {
      await interaction.editReply({ content: text.campaign.refusal.generic, components: [] });
      return;
    }
    const result = await this.deps.play.give(record.key, interaction.user.id, gift.item, gift.toCharacterId, interaction.id);
    await this.showHeroAgain(interaction, record, text, result.kind === "ok" ? text.campaign.reply.offerSent : refusalText(text, result.reason));
  }

  // The sheet and menus again, under a note about what just happened.
  private async showHeroAgain(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts, note: string): Promise<void> {
    await interaction.editReply({
      content: `${note}\n\n${await this.heroSheet(record, text, null, interaction.user.id)}`,
      components: await this.heroMenus(record, text, interaction.user.id),
    });
  }

  // The hero's own portrait as a file for their sheet; undefined when they have none (the sheet is then text only).
  private async heroPortrait(record: CampaignRecord, characterId: string | null, userId: string): Promise<{ attachment: Buffer; name: string } | undefined> {
    const { pictures } = this.deps;
    if (pictures === undefined) return undefined;
    const loaded = await this.deps.unitOfWork.transaction((tx) => tx.loadCampaign(record.key));
    const id = characterId ?? loaded?.state.members[userId]?.characterId ?? null;
    const sheet = id === null ? undefined : loaded?.state.characters[id];
    if (sheet === undefined) return undefined;
    const image = await pictures.full({ characterId: sheet.id, name: sheet.name, ...(sheet.origin === undefined ? {} : { libraryCharacterId: sheet.origin.libraryCharacterId }) });
    if (image === undefined) return undefined;
    const extension = image.mediaType === "image/jpeg" ? "jpg" : image.mediaType === "image/webp" ? "webp" : "png";
    return { attachment: image.bytes, name: `portrait.${extension}` };
  }

  private async heroSheet(record: CampaignRecord, text: Texts, characterId: string | null, userId: string): Promise<string> {
    const loaded = await this.deps.unitOfWork.transaction((tx) => tx.loadCampaign(record.key));
    if (loaded === undefined) return text.campaign.refusal.notActive;
    const id = characterId ?? loaded.state.members[userId]?.characterId ?? null;
    const sheet = id === null ? undefined : loaded.state.characters[id];
    const glossary = this.deps.glossaries[record.language];
    if (sheet === undefined || glossary === undefined) return text.campaign.refusal.noHero;
    const content = this.deps.rulesets.resolve(loaded.ruleset).content;
    return renderHeroSheet(sheet, buildHeroView(loaded.state, sheet, content), text, glossary);
  }
}

