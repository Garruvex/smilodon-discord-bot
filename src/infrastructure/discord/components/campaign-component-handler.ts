import {
  ActionRowBuilder,
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
import type { RulesetCatalog } from "../../../application/campaign/rules/ruleset-catalog.js";
import { buildHeroView } from "../../../application/campaign/views/campaign-views.js";
import { CommandModule } from "../../../application/commands/command.js";
import type { ComponentContext, ComponentHandler, ModalContext } from "../../../application/components/component-handler.js";
import { texts, type Texts } from "../../../application/i18n/texts.js";
import { publicAccessPolicy } from "../../../domain/access/access-policy.js";
import { freeHeroes } from "../../../domain/campaign/lobby/lobby.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import type { CharacterId } from "../../../domain/campaign/core/ids.js";
import type { CombatCommand } from "../../../domain/campaign/commands/campaign-command.js";
import { buildTurnView, type TurnView } from "../../../application/campaign/views/turn-view.js";
import { encodeChoice, parseAim, parseChoice, renderEndConfirm, renderTargetMenu, renderTurnMenu, type TurnChoice, type TurnMenu } from "../campaign/turn-menu.js";
import type { CampaignAction } from "../campaign/campaign-ids.js";
import { campaignCustomId, campaignIdPrefix, parseCampaignId } from "../campaign/campaign-ids.js";
import type { ContentId } from "../../../domain/campaign/rules/content-id.js";
import { isWorn } from "../../../domain/campaign/combat/combatant-profile.js";
import { isFallen } from "../../../domain/campaign/state/campaign-state.js";
import { combatantName } from "../../../application/campaign/dm/combat-records.js";
import { classLabel } from "../campaign/text-keys.js";
import { CampaignCardService } from "../campaign/campaign-card-service.js";
import { renderHeroSheet } from "../campaign/hero-sheet.js";
import { refusalText } from "../campaign/refusal-text.js";

export interface CampaignComponentDependencies {
  readonly lobby: CampaignLobbyService;
  readonly play: CampaignPlayController;
  readonly cards: CampaignCardService;
  readonly unitOfWork: CampaignUnitOfWork;
  readonly rulesets: RulesetCatalog;
  readonly adventures: AdventureLibrary;
  readonly glossaries: Readonly<Record<string, Glossary>>;
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
      return ["adventure"];
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
      return [];
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

  public constructor(private readonly deps: CampaignComponentDependencies) {}

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
      else if (parsed.action === "pick") await this.pickTurnAction(interaction, record, text);
      else if (parsed.action === "aim") await this.aimTurnAction(interaction, record, text);
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
      await interaction.showModal(this.actionModal(record, text));
      return;
    }
    // Buttons inside a private turn menu update that message instead of opening another.
    if (parsed.action === "turnRefresh") {
      await interaction.deferUpdate();
      await this.showTurn(interaction, record, text, null);
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
      case "back":
        return void (await this.outcome(await this.deps.play.back(key, userId, interaction.id), text.campaign.reply.back, reply, text));
      case "continue":
        return void (await this.outcome(await this.deps.play.continue(key, userId, interaction.id), text.campaign.reply.continued, reply, text));
      case "ready":
        return void (await this.outcome(await this.deps.play.ready(key, userId, interaction.id), text.campaign.reply.ready, reply, text));
      case "begin":
        return void (await this.outcome(await this.deps.play.begin(key, userId, interaction.id), text.campaign.reply.began, reply, text));
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
        const gear = parsed.action === "myHero" ? await this.gearControls(record, text, userId) : [];
        await interaction.editReply({ content: sheet, components: gear });
        return;
      }
      default:
        return;
    }
  }

  public async executeModal(context: ModalContext): Promise<void> {
    const { interaction } = context;
    const parsed = parseCampaignId(interaction.customId);
    if (parsed?.action !== "act" || interaction.guildId === null) return;
    const key: CampaignKey = { guildId: interaction.guildId, campaignId: parsed.campaignId };
    const stored = await this.deps.lobby.get(key);
    const text = texts[stored?.record.language ?? "en"];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await this.deps.play.submitAction(key, interaction.user.id, this.field(interaction), interaction.id);
    await interaction.editReply({ content: result.kind === "ok" ? text.campaign.reply.actionSaved : refusalText(text, result.reason) });
  }

  private field(interaction: ModalSubmitInteraction): string {
    return interaction.fields.getTextInputValue(actionField).trim();
  }

  private async outcome(result: PlayResult, success: string, reply: (content: string) => Promise<unknown>, text: Texts): Promise<void> {
    await reply(result.kind === "ok" ? success : refusalText(text, result.reason));
  }

  private actionModal(record: CampaignRecord, text: Texts): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(campaignCustomId("act", record.key.campaignId))
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
    const options = heroes.filter((hero) => available.has(hero.id)).map((hero) => ({ label: text.campaign.pick.option({ hero: hero.name, class: classLabel(text, hero.class) }).slice(0, 100), value: hero.id, default: hero.id === own }));
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

  private async chooseHero(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts): Promise<void> {
    const heroId = interaction.values[0] ?? "";
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
    const heroId = state.members[userId]?.characterId ?? null;
    if (heroId === null) return { kind: "message", content: text.campaign.refusal.noHero };
    const encounter = state.encounter;
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
      components: await this.gearControls(record, text, interaction.user.id),
    });
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

