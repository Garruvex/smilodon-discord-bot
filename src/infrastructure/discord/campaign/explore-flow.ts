import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";

import type { CampaignPlayController, PlayResult } from "../../../application/campaign/campaign-play-controller.js";
import type { AdventureLibrary } from "../../../application/campaign/ports/adventure-library.js";
import type { CampaignRecord } from "../../../application/campaign/ports/campaign-record.js";
import type { CampaignUnitOfWork } from "../../../application/campaign/ports/campaign-store.js";
import { buildExploreView, buildShopView, haggleSkills, pressSkills, sceneNpcs } from "../../../application/campaign/views/explore-view.js";
import type { RulesetCatalog } from "../../../application/campaign/rules/ruleset-catalog.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { isSkill, type Skill } from "../../../domain/campaign/character/character-sheet.js";
import type { AdventureBible } from "../../../domain/campaign/adventure/adventure-bible.js";
import type { CharacterSheet } from "../../../domain/campaign/character/character-sheet.js";
import type { ContentId } from "../../../domain/campaign/rules/content-id.js";
import type { HouseRules } from "../../../domain/campaign/rules/house-rules.js";
import type { CampaignState } from "../../../domain/campaign/state/campaign-state.js";
import type { Glossary, SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import { dcLadder } from "../../../domain/campaign/rules/difficulty.js";
import { maxQuestionLength } from "../../../domain/campaign/engine/dialogue.js";
import { campaignCustomId, type CampaignAction } from "./campaign-ids.js";
import { refusalText } from "./refusal-text.js";
import { skillKey } from "./text-keys.js";

// Between fights (panel spec, Explore): one private screen a player walks
// through, never a command to remember. Explore lists the people in the scene
// and the spells the hero can cast without a slot; a person opens to Ask a
// question, Press for a secret, or Shop. Every choice goes through the play
// controller, which checks the NPC and the price against the adventure, and
// the engine, which checks the rest; what happened is then told to the whole
// table in the Adventure post by the presenter. The NPC rides in the control
// IDs (without its "npc:" prefix) and the shop’s haggle choice with it, so
// nothing is stored.

type Row = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>;
export interface ExploreScreen {
  readonly content: string;
  readonly components: Row[];
}

export interface ExploreFlowDependencies {
  readonly play: Pick<CampaignPlayController, "ask" | "press" | "trade" | "castSpell">;
  readonly unitOfWork: CampaignUnitOfWork;
  readonly rulesets: RulesetCatalog;
  readonly adventures: AdventureLibrary;
  readonly glossaries: Readonly<Record<string, Glossary>>;
}

export const exploreActions: readonly CampaignAction[] = [
  "explore",
  "exploreHome",
  "exploreBack",
  "exploreNpc",
  "exploreAsk",
  "exploreAskSubmit",
  "explorePress",
  "explorePressPick",
  "exploreShop",
  "exploreBuy",
  "exploreSell",
  "exploreHaggle",
  "exploreCast",
  "exploreCastPick",
];
export const isExploreAction = (action: CampaignAction): boolean => exploreActions.includes(action);

const questionField = "question";
// A shop’s haggle choice, as one letter in the control ID.
const haggleCodes: Readonly<Record<string, Skill | undefined>> = { n: undefined, p: "persuasion", d: "deception", i: "intimidation" };
const codeOf = (skill: Skill | undefined): string => Object.entries(haggleCodes).find(([, value]) => value === skill)?.[0] ?? "n";

const withPrefix = (npcArg: string): string => `npc:${npcArg}`;
const withoutPrefix = (npcId: string): string => npcId.replace(/^npc:/, "");

export class ExploreFlow {
  public constructor(private readonly deps: ExploreFlowDependencies) {}

  // The button on the shared panel opens the private screen.
  public async open(interaction: ButtonInteraction, record: CampaignRecord, text: Texts): Promise<void> {
    await interaction.editReply(await this.home(record, text, interaction.user.id));
  }

  public async button(interaction: ButtonInteraction, record: CampaignRecord, text: Texts, action: CampaignAction, argument: string | null): Promise<void> {
    const userId = interaction.user.id;
    switch (action) {
      case "exploreHome":
        return void (await interaction.editReply(await this.home(record, text, userId)));
      case "exploreBack":
        return void (await interaction.editReply(await this.npcScreen(record, text, userId, argument ?? "")));
      case "explorePress":
        return void (await interaction.editReply(await this.pressScreen(record, text, userId, argument ?? "")));
      case "exploreShop":
        return void (await interaction.editReply(await this.shopScreen(record, text, userId, argument ?? "")));
      case "exploreCast":
        return void (await interaction.editReply(await this.castScreen(record, text, userId)));
      default:
        return;
    }
  }

  public async select(interaction: StringSelectMenuInteraction, record: CampaignRecord, text: Texts, action: CampaignAction, argument: string | null): Promise<void> {
    const userId = interaction.user.id;
    const value = interaction.values[0] ?? "";
    switch (action) {
      case "exploreNpc":
        return void (await interaction.editReply(await this.npcScreen(record, text, userId, withoutPrefix(value))));
      case "explorePressPick": {
        const npc = argument ?? "";
        const skill = isSkill(value) ? value : undefined;
        if (skill === undefined) return void (await interaction.editReply(await this.pressScreen(record, text, userId, npc)));
        const result = await this.deps.play.press(record.key, userId, withPrefix(npc), skill, interaction.id);
        const name = this.npcNameIn(record, withPrefix(npc));
        return void (await interaction.editReply(await this.npcScreen(record, text, userId, npc, this.told(text, result, text.campaign.explore.pressed({ name })))));
      }
      case "exploreHaggle": {
        const [npc = "", code = "n"] = (argument ?? "").split(".");
        return void (await interaction.editReply(await this.shopScreen(record, text, userId, `${npc}.${value in haggleCodes ? value : code}`)));
      }
      case "exploreBuy":
      case "exploreSell": {
        const [npc = "", code = "n"] = (argument ?? "").split(".");
        const result = await this.deps.play.trade(
          record.key,
          userId,
          { npcId: withPrefix(npc), itemId: value as ContentId<"item">, direction: action === "exploreBuy" ? "buy" : "sell", ...(haggleCodes[code] === undefined ? {} : { haggle: haggleCodes[code] }) },
          interaction.id,
        );
        const name = this.npcNameIn(record, withPrefix(npc));
        return void (await interaction.editReply(await this.shopScreen(record, text, userId, argument ?? "", this.told(text, result, text.campaign.explore.traded({ name })))));
      }
      case "exploreCastPick": {
        const result = await this.deps.play.castSpell(record.key, userId, value as ContentId<"spell">, interaction.id);
        const spell = this.deps.glossaries[record.language]?.names[value] ?? value;
        return void (await interaction.editReply(await this.home(record, text, userId, this.told(text, result, text.campaign.explore.cast({ spell })))));
      }
      default:
        return;
    }
  }

  // Ask a question: a form, which has to be the first response to the click.
  public askModal(record: CampaignRecord, text: Texts, npcArg: string): ModalBuilder {
    const t = text.campaign.explore;
    const name = this.npcNameIn(record, withPrefix(npcArg));
    return new ModalBuilder()
      .setCustomId(campaignCustomId("exploreAskSubmit", record.key.campaignId, npcArg))
      .setTitle(t.askTitle({ name }).slice(0, 45))
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder().setCustomId(questionField).setLabel(t.askLabel).setPlaceholder(t.askPlaceholder).setStyle(TextInputStyle.Paragraph).setMaxLength(maxQuestionLength).setRequired(true),
        ),
      );
  }

  public async submitAsk(interaction: ModalSubmitInteraction, record: CampaignRecord, text: Texts, npcArg: string): Promise<void> {
    const question = interaction.fields.getTextInputValue(questionField);
    const result = await this.deps.play.ask(record.key, interaction.user.id, withPrefix(npcArg), question, interaction.id);
    const name = this.npcNameIn(record, withPrefix(npcArg));
    await interaction.editReply(await this.npcScreen(record, text, interaction.user.id, npcArg, this.told(text, result, text.campaign.explore.asked({ name }))));
  }

  // ---- screens ---------------------------------------------------------------

  private told(text: Texts, result: PlayResult, success: string): string {
    return result.kind === "ok" ? success : refusalText(text, result.reason);
  }

  private async load(record: CampaignRecord, userId: string): Promise<{ state: CampaignState; bible: AdventureBible; glossary: Glossary; hero: CharacterSheet; content: SealedContent; houseRules: HouseRules } | null> {
    const loaded = await this.deps.unitOfWork.transaction((tx) => tx.loadCampaign(record.key));
    const bible = this.deps.adventures.find(record.adventure.adventureId, record.adventure.version, record.language);
    const glossary = this.deps.glossaries[record.language];
    const heroId = loaded?.state.members[userId]?.characterId ?? null;
    const hero = heroId === null ? undefined : loaded?.state.characters[heroId];
    if (loaded === undefined || bible === undefined || glossary === undefined || hero === undefined) return null;
    const { content, houseRules } = this.deps.rulesets.resolve(loaded.ruleset);
    return { state: loaded.state, bible, glossary, hero, content, houseRules };
  }

  private noHero(text: Texts): ExploreScreen {
    return { content: text.campaign.refusal.noHero, components: [] };
  }

  private npcNameIn(record: CampaignRecord, npcId: string): string {
    return this.deps.adventures.find(record.adventure.adventureId, record.adventure.version, record.language)?.npcs.find((npc) => npc.id === npcId)?.name ?? withoutPrefix(npcId);
  }

  private back(action: CampaignAction, record: CampaignRecord, text: Texts, argument?: string): ButtonBuilder {
    return new ButtonBuilder().setCustomId(campaignCustomId(action, record.key.campaignId, argument)).setLabel(text.campaign.explore.backButton).setStyle(ButtonStyle.Secondary);
  }

  public async home(record: CampaignRecord, text: Texts, userId: string, note?: string): Promise<ExploreScreen> {
    const loaded = await this.load(record, userId);
    if (loaded === null) return this.noHero(text);
    const t = text.campaign.explore;
    const view = buildExploreView(loaded.state, loaded.bible, loaded.content, loaded.glossary, loaded.hero.id);
    const lines = [...(note === undefined ? [] : [note, ""]), t.title({ hero: loaded.hero.name }), view.npcs.length === 0 && view.spells.length === 0 ? t.nobody : t.intro];
    const rows: Row[] = [];
    if (view.npcs.length > 0) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(campaignCustomId("exploreNpc", record.key.campaignId))
            .setPlaceholder(t.npcPlaceholder)
            .addOptions(view.npcs.slice(0, 25).map((npc) => ({ label: npc.name.slice(0, 100), description: (npc.trades ? `${t.trades} · ${npc.description}` : npc.description).slice(0, 100), value: npc.id }))),
        ),
      );
    }
    if (view.spells.length > 0) {
      rows.push(
        new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(
          new ButtonBuilder().setCustomId(campaignCustomId("exploreCast", record.key.campaignId)).setLabel(t.castButton).setStyle(ButtonStyle.Secondary),
        ),
      );
    }
    return { content: lines.join("\n"), components: rows };
  }

  private async npcScreen(record: CampaignRecord, text: Texts, userId: string, npcArg: string, note?: string): Promise<ExploreScreen> {
    const loaded = await this.load(record, userId);
    if (loaded === null) return this.noHero(text);
    const t = text.campaign.explore;
    const npc = sceneNpcs(loaded.state, loaded.bible).find((candidate) => candidate.id === withPrefix(npcArg));
    if (npc === undefined) return this.home(record, text, userId, refusalText(text, "npcNotHere"));
    const known = loaded.state.npcSecretsRevealed?.[npc.id] === true;
    const id = record.key.campaignId;
    const button = (action: CampaignAction, label: string, style = ButtonStyle.Secondary, disabled = false): ButtonBuilder =>
      new ButtonBuilder().setCustomId(campaignCustomId(action, id, npcArg)).setLabel(label).setStyle(style).setDisabled(disabled);
    return {
      content: [...(note === undefined ? [] : [note, ""]), `**${npc.name}**`, npc.publicDescription, ...(known ? ["", t.secretKnown] : [])].join("\n"),
      components: [
        new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(
          button("exploreAsk", t.askButton, ButtonStyle.Primary),
          button("explorePress", t.pressButton, ButtonStyle.Secondary, known),
          ...(npc.shop === undefined ? [] : [new ButtonBuilder().setCustomId(campaignCustomId("exploreShop", id, `${npcArg}.n`)).setLabel(t.shopButton).setStyle(ButtonStyle.Secondary)]),
          this.back("exploreHome", record, text),
        ),
      ],
    };
  }

  private async pressScreen(record: CampaignRecord, text: Texts, userId: string, npcArg: string): Promise<ExploreScreen> {
    const loaded = await this.load(record, userId);
    if (loaded === null) return this.noHero(text);
    const t = text.campaign.explore;
    const name = this.npcNameIn(record, withPrefix(npcArg));
    return {
      content: t.pressPrompt({ name, dc: dcLadder.hard }),
      components: [
        new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(campaignCustomId("explorePressPick", record.key.campaignId, npcArg))
            .setPlaceholder(t.pressPlaceholder)
            .addOptions(pressSkills.map((skill) => ({ label: text.campaign.skill[skillKey(skill)], value: skill }))),
        ),
        new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(this.back("exploreBack", record, text, npcArg)),
      ],
    };
  }

  // The shop: what is for sale, what they will buy, how the hero pays, and whether to haggle.
  private async shopScreen(record: CampaignRecord, text: Texts, userId: string, arg: string, note?: string): Promise<ExploreScreen> {
    const loaded = await this.load(record, userId);
    if (loaded === null) return this.noHero(text);
    const t = text.campaign.explore;
    const [npcArg = "", code = "n"] = arg.split(".");
    const haggle = haggleCodes[code];
    const shop = buildShopView(loaded.state, loaded.bible, loaded.glossary, loaded.houseRules, loaded.hero.id, withPrefix(npcArg));
    if (shop === undefined) return this.home(record, text, userId, refusalText(text, "npcNotHere"));
    const state = `${npcArg}.${codeOf(haggle)}`;
    const lines = (items: typeof shop.buy): string => (items.length === 0 ? t.shopNothing : items.map((line) => t.shopLine({ item: line.name, price: line.price })).join("\n"));
    const menu = (action: CampaignAction, placeholder: string, options: readonly { label: string; value: string; description?: string; default?: boolean }[]): Row =>
      new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(campaignCustomId(action, record.key.campaignId, state)).setPlaceholder(placeholder).addOptions(options.slice(0, 25).map((option) => ({ ...option, label: option.label.slice(0, 100) }))),
      );
    const rows: Row[] = [];
    if (shop.buy.length > 0) rows.push(menu("exploreBuy", t.buyPlaceholder, shop.buy.map((line) => ({ label: t.option({ item: line.name, price: line.price }), value: line.itemId }))));
    if (shop.sell.length > 0) rows.push(menu("exploreSell", t.sellPlaceholder, shop.sell.map((line) => ({ label: t.option({ item: line.name, price: line.price }), value: line.itemId }))));
    rows.push(
      menu("exploreHaggle", t.hagglePlaceholder, [
        { label: t.haggleNone, value: "n", default: haggle === undefined },
        ...haggleSkills.map((skill) => ({ label: t.haggleWith({ skill: text.campaign.skill[skillKey(skill)], dc: dcLadder.medium }), value: codeOf(skill), default: haggle === skill })),
      ]),
      new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(this.back("exploreBack", record, text, npcArg)),
    );
    return {
      content: [
        ...(note === undefined ? [] : [note, ""]),
        t.shopTitle({ name: shop.npc.name }),
        t.shopGold({ gold: shop.gold, wallet: shop.wallet === "pool" ? t.walletPool : t.walletHero }),
        "",
        `**${t.shopBuyHeader}**`,
        lines(shop.buy),
        `**${t.shopSellHeader}**`,
        lines(shop.sell),
      ].join("\n"),
      components: rows,
    };
  }

  private async castScreen(record: CampaignRecord, text: Texts, userId: string): Promise<ExploreScreen> {
    const loaded = await this.load(record, userId);
    if (loaded === null) return this.noHero(text);
    const t = text.campaign.explore;
    const view = buildExploreView(loaded.state, loaded.bible, loaded.content, loaded.glossary, loaded.hero.id);
    if (view.spells.length === 0) return this.home(record, text, userId, t.noSpells);
    return {
      content: t.castPlaceholder,
      components: [
        new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(campaignCustomId("exploreCastPick", record.key.campaignId))
            .setPlaceholder(t.castPlaceholder)
            .addOptions(view.spells.slice(0, 25).map((spell) => ({ label: spell.name.slice(0, 100), description: spell.cantrip ? t.castCantrip : t.castRitual, value: spell.id }))),
        ),
        new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(this.back("exploreHome", record, text)),
      ],
    };
  }
}
