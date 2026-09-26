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
  type MessageActionRowComponentBuilder,
  type StringSelectMenuInteraction,
} from "discord.js";

import type { CampaignLobbyService } from "../../../application/campaign/campaign-lobby-service.js";
import type { CampaignPlayController } from "../../../application/campaign/campaign-play-controller.js";
import type { CampaignRecord } from "../../../application/campaign/ports/campaign-record.js";
import type { CampaignKey } from "../../../application/campaign/ports/campaign-store.js";
import { CommandModule } from "../../../application/commands/command.js";
import type { ComponentContext, ComponentHandler, ModalContext } from "../../../application/components/component-handler.js";
import { texts, type Texts } from "../../../application/i18n/texts.js";
import { publicAccessPolicy } from "../../../domain/access/access-policy.js";
import type { CampaignAuthority } from "../campaign/campaign-authority.js";
import type { CampaignCardService } from "../campaign/campaign-card-service.js";
import { createGameText, type CampaignGameCreator } from "../campaign/campaign-game-creator.js";
import type { CampaignSetupService } from "../campaign/campaign-setup-service.js";
import {
  defaultWizardChoices,
  hubCustomId,
  hubIdPrefix,
  isManageVerb,
  parseHubId,
  parseWizardState,
  wizardState,
  type ManageVerb,
  type WizardChoices,
} from "../campaign/hub-ids.js";
import { refusalText } from "../campaign/refusal-text.js";

export interface CampaignHubDependencies {
  readonly lobby: CampaignLobbyService;
  readonly play: CampaignPlayController;
  readonly setup: CampaignSetupService;
  readonly cards: CampaignCardService;
  readonly creator: CampaignGameCreator;
  readonly authority: CampaignAuthority;
}

interface Screen {
  readonly content: string;
  readonly components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

const nameField = "name";

// The hub's controls: the Create game wizard and each game's Manage view. All
// replies are private. Who may do what is decided on every click from the
// server's DnD Admin role and the game's organizer, never from the message.
export class CampaignHubComponentHandler implements ComponentHandler {
  public readonly customIdPrefix = hubIdPrefix;
  public readonly module = CommandModule.Campaign;
  public readonly access = publicAccessPolicy;

  public constructor(private readonly deps: CampaignHubDependencies) {}

  public async execute(context: ComponentContext): Promise<void> {
    const { interaction } = context;
    const parsed = parseHubId(interaction.customId);
    if (parsed === null || !interaction.inCachedGuild()) return;
    const [first, second] = parsed.parts;
    switch (parsed.action) {
      case "create":
        if (interaction.isButton()) await this.startWizard(interaction);
        return;
      case "wizLanguage":
      case "wizPacing":
      case "wizPlayers":
        if (interaction.isStringSelectMenu()) await this.chooseOption(interaction, parsed.action, first);
        return;
      case "wizNext":
        if (interaction.isButton()) await this.askName(interaction, first);
        return;
      case "manage":
        if (interaction.isButton() && first !== undefined) await this.openManage(interaction, first);
        return;
      case "do":
        if (interaction.isButton() && first !== undefined) await this.runManage(interaction, first, second);
        return;
      case "endAsk":
        if (interaction.isButton() && first !== undefined) await this.askEnd(interaction, first);
        return;
      case "endYes":
        if (interaction.isButton() && first !== undefined) await this.end(interaction, first);
        return;
      default:
        return;
    }
  }

  public async executeModal(context: ModalContext): Promise<void> {
    const { interaction } = context;
    const parsed = parseHubId(interaction.customId);
    if (parsed?.action !== "wizName" || !interaction.inCachedGuild()) return;
    const choices = parseWizardState(parsed.parts[0]);
    const text = texts[choices.language];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await this.deps.authority.isAdmin(interaction))) {
      await interaction.editReply({ content: text.campaign.wizard.notAllowed });
      return;
    }
    const result = await this.deps.creator.create({
      guildId: interaction.guildId,
      organizerId: interaction.user.id,
      name: interaction.fields.getTextInputValue(nameField),
      language: choices.language,
      pacing: choices.pacing,
      players: choices.players,
    });
    await interaction.editReply({ content: createGameText(result, text) });
  }

  // ---- Create game --------------------------------------------------------

  private async startWizard(interaction: ButtonInteraction<"cached">): Promise<void> {
    const text = texts.en;
    if (!(await this.deps.authority.isAdmin(interaction))) {
      await interaction.reply({ content: text.campaign.wizard.notAllowed, flags: MessageFlags.Ephemeral });
      return;
    }
    if (!this.deps.creator.modelConfigured) {
      await interaction.reply({ content: text.campaign.cmd.noModel, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ ...wizardScreen(defaultWizardChoices), flags: MessageFlags.Ephemeral });
  }

  private async chooseOption(interaction: StringSelectMenuInteraction<"cached">, action: "wizLanguage" | "wizPacing" | "wizPlayers", state: string | undefined): Promise<void> {
    const current = parseWizardState(state);
    if (!(await this.deps.authority.isAdmin(interaction))) {
      await interaction.update({ content: texts[current.language].campaign.wizard.notAllowed, components: [] });
      return;
    }
    const value = interaction.values[0] ?? "";
    const next: WizardChoices =
      action === "wizLanguage"
        ? { ...current, language: value === "zh-TW" ? "zh-TW" : "en" }
        : action === "wizPacing"
          ? { ...current, pacing: value === "playByPost" ? "playByPost" : "live" }
          : { ...current, players: parseWizardState(`en.live.${value}`).players };
    await interaction.update(wizardScreen(next));
  }

  private async askName(interaction: ButtonInteraction<"cached">, state: string | undefined): Promise<void> {
    const choices = parseWizardState(state);
    const text = texts[choices.language].campaign.wizard;
    if (!(await this.deps.authority.isAdmin(interaction))) {
      await interaction.update({ content: text.notAllowed, components: [] });
      return;
    }
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(hubCustomId("wizName", wizardState(choices)))
        .setTitle(text.nameTitle)
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder().setCustomId(nameField).setLabel(text.nameLabel).setPlaceholder(text.namePlaceholder).setStyle(TextInputStyle.Short).setMinLength(2).setMaxLength(60).setRequired(true),
          ),
        ),
    );
  }

  // ---- Manage a game ------------------------------------------------------

  private async openManage(interaction: ButtonInteraction<"cached">, campaignId: string): Promise<void> {
    const key: CampaignKey = { guildId: interaction.guildId, campaignId };
    const record = (await this.deps.lobby.get(key))?.record;
    if (record === undefined) {
      await interaction.reply({ content: texts.en.campaign.manage.gone, flags: MessageFlags.Ephemeral });
      this.refreshHub(interaction.guildId);
      return;
    }
    const text = texts[record.language];
    // A control on a message that is no longer the game's hub message is obsolete.
    if (record.cards.hub?.messageId !== interaction.message.id) {
      await interaction.reply({ content: text.campaign.reply.obsolete, flags: MessageFlags.Ephemeral });
      this.refreshHub(interaction.guildId);
      return;
    }
    if (!(await this.deps.authority.canManage(interaction, record))) {
      await interaction.reply({ content: text.campaign.manage.notAllowed, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await interaction.editReply(await this.manageScreen(record, text));
  }

  private async runManage(interaction: ButtonInteraction<"cached">, campaignId: string, verb: string | undefined): Promise<void> {
    const found = await this.allowed(interaction, campaignId);
    if (found === null) return;
    const { record, text } = found;
    let notice = "";
    if (verb === "repair") {
      await interaction.deferUpdate();
      await this.deps.setup.provision(record.key);
      await this.deps.cards.sync(record.key, true);
      notice = text.campaign.cmd.repaired;
    } else if (isManageVerb(verb) && verb !== "repair") {
      await interaction.deferUpdate();
      const result = await this.deps.play.manage(record.key, verb, interaction.id);
      notice = result.kind === "ok" ? successText(verb, text) : refusalText(text, result.reason);
    } else {
      await interaction.deferUpdate();
      notice = text.campaign.manage.kept;
    }
    const latest = (await this.deps.lobby.get(record.key))?.record ?? record;
    const screen = await this.manageScreen(latest, text);
    await interaction.editReply({ content: `${notice}\n\n${screen.content}`, components: screen.components });
  }

  private async askEnd(interaction: ButtonInteraction<"cached">, campaignId: string): Promise<void> {
    const found = await this.allowed(interaction, campaignId);
    if (found === null) return;
    const { record, text } = found;
    const t = text.campaign.manage;
    await interaction.update({
      content: t.endConfirm({ name: record.name }),
      components: [
        row(
          new ButtonBuilder().setCustomId(hubCustomId("endYes", record.key.campaignId)).setLabel(t.endYes).setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(hubCustomId("do", record.key.campaignId, "keep")).setLabel(t.endNo).setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  }

  private async end(interaction: ButtonInteraction<"cached">, campaignId: string): Promise<void> {
    const found = await this.allowed(interaction, campaignId);
    if (found === null) return;
    const { record, text } = found;
    await interaction.deferUpdate();
    const ended = await this.deps.lobby.end(record.key);
    if (ended.kind === "refused") {
      await interaction.editReply({ content: refusalText(text, ended.reason), components: [] });
      return;
    }
    // The game's cards show it as finished and its hub message goes.
    await this.deps.cards.sync(record.key);
    await interaction.editReply({ content: text.campaign.manage.ended({ name: record.name }), components: [] });
  }

  // The game the click is about, when the clicker may manage it. Otherwise the
  // click is answered here and null is returned.
  private async allowed(interaction: ButtonInteraction<"cached">, campaignId: string): Promise<{ record: CampaignRecord; text: Texts } | null> {
    const record = (await this.deps.lobby.get({ guildId: interaction.guildId, campaignId }))?.record;
    if (record === undefined) {
      await interaction.update({ content: texts.en.campaign.manage.gone, components: [] });
      return null;
    }
    const text = texts[record.language];
    if (!(await this.deps.authority.canManage(interaction, record))) {
      await interaction.update({ content: text.campaign.manage.notAllowed, components: [] });
      return null;
    }
    if (record.lifecycle === "archived") {
      await interaction.update({ content: text.campaign.manage.finished, components: [] });
      return null;
    }
    return { record, text };
  }

  private async manageScreen(record: CampaignRecord, text: Texts): Promise<Screen> {
    const t = text.campaign.manage;
    const described = record.lifecycle === "lobby" ? undefined : await this.deps.cards.describe(record.key);
    const mode = described?.panel?.mode ?? null;
    const paused = mode === "paused" || mode === "recovery";
    const status = mode === null ? "" : text.campaign.mode[mode];
    const id = record.key.campaignId;
    const verb = (action: ManageVerb, label: string): ButtonBuilder => new ButtonBuilder().setCustomId(hubCustomId("do", id, action)).setLabel(label).setStyle(ButtonStyle.Secondary);
    const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    if (record.lifecycle !== "lobby") {
      rows.push(
        row(paused ? verb("resume", t.resume).setStyle(ButtonStyle.Success) : verb("pause", t.pause), verb("closeRound", t.closeRound), verb("retry", t.retry)),
        row(verb("shortRest", t.shortRest), verb("longRest", t.longRest)),
      );
    }
    rows.push(row(verb("repair", t.repair), new ButtonBuilder().setCustomId(hubCustomId("endAsk", id)).setLabel(t.end).setStyle(ButtonStyle.Danger)));
    return { content: `**${t.title({ name: record.name })}**${status === "" ? "" : ` · ${status}`}`, components: rows };
  }

  private refreshHub(guildId: string): void {
    void this.deps.cards.syncHub(guildId).catch(() => undefined);
  }
}

function row(...buttons: ButtonBuilder[]): ActionRowBuilder<MessageActionRowComponentBuilder> {
  return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(buttons);
}

function successText(verb: ManageVerb, text: Texts): string {
  const t = text.campaign.cmd;
  switch (verb) {
    case "pause":
      return t.paused;
    case "resume":
      return t.resumed;
    case "closeRound":
      return t.roundClosed;
    case "retry":
      return t.retried;
    case "shortRest":
    case "longRest":
      return t.rested;
    case "repair":
      return t.repaired;
  }
}

// The wizard: the choices so far live in each control's custom ID.
function wizardScreen(choices: WizardChoices): Screen {
  const text = texts[choices.language];
  const t = text.campaign.wizard;
  const state = wizardState(choices);
  const select = (action: "wizLanguage" | "wizPacing" | "wizPlayers", placeholder: string, options: readonly { label: string; value: string; selected: boolean }[]): ActionRowBuilder<MessageActionRowComponentBuilder> =>
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(hubCustomId(action, state))
        .setPlaceholder(placeholder)
        .addOptions(options.map((option) => ({ label: option.label, value: option.value, default: option.selected }))),
    );
  const language = choices.language === "en" ? text.campaign.language.en : text.campaign.language.zhTW;
  const pacing = choices.pacing === "live" ? text.campaign.pacing.live : text.campaign.pacing.playByPost;
  return {
    content: `**${t.title}**\n${t.intro}\n\n${t.summary({ language, pacing, count: choices.players })}`,
    components: [
      select("wizLanguage", t.languagePlaceholder, [
        { label: text.campaign.language.en, value: "en", selected: choices.language === "en" },
        { label: text.campaign.language.zhTW, value: "zh-TW", selected: choices.language === "zh-TW" },
      ]),
      select("wizPacing", t.pacingPlaceholder, [
        { label: t.pacingLive, value: "live", selected: choices.pacing === "live" },
        { label: t.pacingPost, value: "playByPost", selected: choices.pacing === "playByPost" },
      ]),
      select(
        "wizPlayers",
        t.playersPlaceholder,
        [1, 2, 3, 4, 5, 6].map((count) => ({ label: t.players({ count }), value: String(count), selected: choices.players === count })),
      ),
      row(new ButtonBuilder().setCustomId(hubCustomId("wizNext", state)).setLabel(t.next).setStyle(ButtonStyle.Primary)),
    ],
  };
}
