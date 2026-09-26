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
import type { CampaignAction } from "../campaign/campaign-ids.js";
import { campaignCustomId, campaignIdPrefix, parseCampaignId } from "../campaign/campaign-ids.js";
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
      return ["adventure"];
    case "myHero":
      return ["adventure", "party"];
    case "details":
      return [`hero:${argument ?? ""}`];
    case "heroChoice":
    case "newHero":
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
      case "myHero":
      case "details": {
        // A player whose hero fell is offered a new one instead of a sheet.
        const options = parsed.action === "myHero" ? await this.deps.play.replacementOptions(key, userId) : [];
        if (options.length > 0) {
          await this.showReplacementPicker(interaction, record, text, options);
          return;
        }
        await reply(await this.heroSheet(record, text, parsed.action === "details" ? parsed.argument : null, userId));
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
    const options = heroes.filter((hero) => available.has(hero.id)).map((hero) => ({ label: text.campaign.pick.option({ hero: hero.name, class: hero.class }).slice(0, 100), value: hero.id, default: hero.id === own }));
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
            .addOptions(options.map((option) => ({ label: text.campaign.pick.option({ hero: option.name, class: option.className }).slice(0, 100), value: option.id }))),
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

  // The sheet of the clicker's own hero (My Hero) or a named one (Details on a hero card).
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

