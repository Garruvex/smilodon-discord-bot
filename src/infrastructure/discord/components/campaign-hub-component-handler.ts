import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  FileUploadBuilder,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";

import type { CampaignLobbyService } from "../../../application/campaign/campaign-lobby-service.js";
import { hurtKinds, type CampaignPlayController } from "../../../application/campaign/campaign-play-controller.js";
import type { CampaignRecord } from "../../../application/campaign/ports/campaign-record.js";
import type { CampaignKey } from "../../../application/campaign/ports/campaign-store.js";
import { CommandModule } from "../../../application/commands/command.js";
import type { ComponentContext, ComponentHandler, ModalContext } from "../../../application/components/component-handler.js";
import { texts, type Texts } from "../../../application/i18n/texts.js";
import { publicAccessPolicy } from "../../../domain/access/access-policy.js";
import { abilities } from "../../../domain/campaign/rules/effects.js";
import { maxIdeaChars } from "../../../application/campaign/adventures/adventure-author.js";
import type { AdventureIntake, IntakeContext } from "../campaign/adventure-intake.js";
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
import { languageOf, type CharacterLibraryComponentHandler } from "./character-library-component-handler.js";
import { repairText } from "../campaign/repair-text.js";

export interface CampaignHubDependencies {
  readonly lobby: CampaignLobbyService;
  readonly play: CampaignPlayController;
  readonly setup: CampaignSetupService;
  readonly cards: CampaignCardService;
  readonly creator: CampaignGameCreator;
  readonly authority: CampaignAuthority;
  // The launcher's character and adventure buttons; without them those buttons say they are unavailable.
  readonly libraryScreens?: Pick<CharacterLibraryComponentHandler, "homeScreen" | "builderScreen" | "importFromFile">;
  readonly intake?: Pick<AdventureIntake, "uploadFile" | "authorFrom" | "canAuthor">;
  // The adventures this server can start from; without it the wizard offers only the bundled one.
  readonly adventures?: { listForGuild(guildId: string): readonly { readonly id: string; readonly titles: Readonly<Partial<Record<"en" | "zh-TW", string>>> }[] };
}

interface Screen {
  readonly content: string;
  readonly components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

const nameField = "name";
const fileField = "file";
const ideaField = "idea";
const languageField = "language";
const levelField = "level";
const whoField = "who";
const abilityField = "ability";
const dcField = "dc";
const kindField = "kind";
const amountField = "amount";
const entranceField = "entrance";

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
      case "wizLoot":
        if (interaction.isStringSelectMenu()) await this.chooseOption(interaction, parsed.action, first);
        return;
      case "wizVisibility":
        if (interaction.isButton()) await this.toggleVisibility(interaction, first);
        return;
      case "wizAdventure":
        if (interaction.isButton()) await this.cycleAdventure(interaction, first);
        return;
      case "wizNext":
        if (interaction.isButton()) await this.askName(interaction, first);
        return;
      case "manage":
        if (interaction.isButton() && first !== undefined) await this.openManage(interaction, first);
        return;
      case "inviteOpen":
        if (interaction.isButton() && first !== undefined) await this.chooseInvitee(interaction, first);
        return;
      case "inviteUser":
        if (interaction.isUserSelectMenu() && first !== undefined) await this.openJoinForm(interaction, first, "inviteOpen", interaction.values[0]);
        return;
      case "joinApproveOpen":
        if (interaction.isButton() && first !== undefined) await this.openJoinForm(interaction, first, parsed.action, second);
        return;
      case "joinRequests":
        if (interaction.isButton() && first !== undefined) await this.showJoinRequests(interaction, first);
        return;
      case "joinDecline":
        if (interaction.isButton() && first !== undefined && second !== undefined) await this.declineJoin(interaction, first, second);
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
      case "help":
        if (interaction.isButton()) await interaction.reply({ content: texts[languageOf(interaction)].campaign.hub.help, flags: MessageFlags.Ephemeral });
        return;
      case "characters":
      case "newCharacter":
        if (interaction.isButton()) await this.openLibrary(interaction, parsed.action);
        return;
      case "importOpen":
        if (interaction.isButton()) await this.openImport(interaction);
        return;
      case "uploadOpen":
      case "authorOpen":
        if (interaction.isButton()) await this.openAdventureForm(interaction, parsed.action);
        return;
      case "levelOpen":
        if (interaction.isButton() && first !== undefined) await this.openLevel(interaction, first);
        return;
      case "hazardOpen":
        if (interaction.isButton() && first !== undefined) await this.openHazard(interaction, first);
        return;
      case "hurtOpen":
        if (interaction.isButton() && first !== undefined) await this.openHurt(interaction, first);
        return;
      default:
        return;
    }
  }

  public async executeModal(context: ModalContext): Promise<void> {
    const { interaction } = context;
    const parsed = parseHubId(interaction.customId);
    if (parsed === null || !interaction.inCachedGuild()) return;
    if (parsed.action === "importSubmit") return void (await this.submitImport(interaction));
    if (parsed.action === "uploadSubmit") return void (await this.submitUpload(interaction));
    if (parsed.action === "authorSubmit") return void (await this.submitAuthor(interaction));
    if (parsed.action === "levelSubmit") return void (await this.submitLevel(interaction, parsed.parts[0] ?? ""));
    if (parsed.action === "hazardSubmit") return void (await this.submitHazard(interaction, parsed.parts[0] ?? ""));
    if (parsed.action === "hurtSubmit") return void (await this.submitHurt(interaction, parsed.parts[0] ?? ""));
    if (parsed.action === "inviteSubmit" || parsed.action === "joinApproveSubmit") return void (await this.submitJoinForm(interaction, parsed.parts[0] ?? "", parsed.action, parsed.parts[1]));
    if (parsed.action !== "wizName") return;
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
      lootGold: choices.loot,
      visibility: choices.visibility,
      ...(choices.adventure === null ? {} : { adventureId: choices.adventure }),
    });
    await interaction.editReply({ content: createGameText(result, text) });
  }

  // ---- The launcher: characters and adventures -------------------------------

  // My Characters and New character: the same private screens /dnd characters opens.
  private async openLibrary(interaction: ButtonInteraction<"cached">, action: "characters" | "newCharacter"): Promise<void> {
    const language = languageOf(interaction);
    if (this.deps.libraryScreens === undefined) {
      await interaction.reply({ content: texts[language].campaign.hub.unavailable, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const screen = action === "characters" ? await this.deps.libraryScreens.homeScreen(interaction.user.id, language) : this.deps.libraryScreens.builderScreen(language);
    await interaction.editReply({ content: screen.content, components: screen.components });
  }

  private fileModal(customId: string, title: string, label: string, hint: string, required: boolean): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(customId)
      .setTitle(title)
      .addLabelComponents(new LabelBuilder().setLabel(label).setDescription(hint).setFileUploadComponent(new FileUploadBuilder().setCustomId(fileField).setRequired(required).setMinValues(required ? 1 : 0).setMaxValues(1)));
  }

  private async openImport(interaction: ButtonInteraction<"cached">): Promise<void> {
    const t = texts[languageOf(interaction)].campaign.hub;
    if (this.deps.libraryScreens === undefined) {
      await interaction.reply({ content: t.unavailable, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(this.fileModal(hubCustomId("importSubmit"), t.importTitle, t.importFileLabel, t.importFileHint, true));
  }

  private async submitImport(interaction: ModalSubmitInteraction<"cached">): Promise<void> {
    const language = languageOf(interaction);
    const t = texts[language].campaign.hub;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (this.deps.libraryScreens === undefined) return void (await interaction.editReply({ content: t.unavailable }));
    const file = interaction.fields.getUploadedFiles(fileField, false)?.first();
    await interaction.editReply({ content: await this.deps.libraryScreens.importFromFile(interaction.user.id, language, file === undefined ? null : { url: file.url, size: file.size }) });
  }

  // Upload adventure and Write an adventure: for DnD Admins, like the slash commands.
  private async openAdventureForm(interaction: ButtonInteraction<"cached">, action: "uploadOpen" | "authorOpen"): Promise<void> {
    const language = languageOf(interaction);
    const text = texts[language];
    const t = text.campaign.hub;
    if (!(await this.deps.authority.isAdmin(interaction))) {
      await interaction.reply({ content: text.campaign.cmd.adminOnly, flags: MessageFlags.Ephemeral });
      return;
    }
    if (this.deps.intake === undefined) {
      await interaction.reply({ content: t.unavailable, flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "uploadOpen") {
      await interaction.showModal(this.fileModal(hubCustomId("uploadSubmit"), t.uploadTitle, t.uploadFileLabel, t.uploadFileHint, true));
      return;
    }
    if (!this.deps.intake.canAuthor) {
      await interaction.reply({ content: text.campaign.adventure.authorNoModel, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(hubCustomId("authorSubmit"))
        .setTitle(t.authorTitle)
        .addLabelComponents(
          new LabelBuilder()
            .setLabel(t.authorIdeaLabel)
            .setTextInputComponent(new TextInputBuilder().setCustomId(ideaField).setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(maxIdeaChars).setPlaceholder(t.authorIdeaPlaceholder)),
          new LabelBuilder()
            .setLabel(t.authorLanguageLabel)
            .setStringSelectMenuComponent(
              new StringSelectMenuBuilder()
                .setCustomId(languageField)
                .setRequired(true)
                .addOptions([
                  { label: text.campaign.language.en, value: "en", default: language === "en" },
                  { label: text.campaign.language.zhTW, value: "zh-TW", default: language === "zh-TW" },
                ]),
            ),
          new LabelBuilder().setLabel(t.authorNotesLabel).setDescription(t.authorNotesHint).setFileUploadComponent(new FileUploadBuilder().setCustomId(fileField).setRequired(false).setMinValues(0).setMaxValues(1)),
        ),
    );
  }

  private intakeContext(interaction: ModalSubmitInteraction<"cached">): IntakeContext {
    return {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      language: languageOf(interaction),
      editReply: (payload) => interaction.editReply(payload),
    };
  }

  private async submitUpload(interaction: ModalSubmitInteraction<"cached">): Promise<void> {
    const text = texts[languageOf(interaction)];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // A form can be sent by anyone who got hold of it; the admin check is made again.
    if (!(await this.deps.authority.isAdmin(interaction))) return void (await interaction.editReply({ content: text.campaign.cmd.adminOnly }));
    if (this.deps.intake === undefined) return void (await interaction.editReply({ content: text.campaign.hub.unavailable }));
    const file = interaction.fields.getUploadedFiles(fileField, false)?.first();
    await this.deps.intake.uploadFile(this.intakeContext(interaction), file === undefined ? null : { url: file.url, size: file.size });
  }

  private async submitAuthor(interaction: ModalSubmitInteraction<"cached">): Promise<void> {
    const text = texts[languageOf(interaction)];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!(await this.deps.authority.isAdmin(interaction))) return void (await interaction.editReply({ content: text.campaign.cmd.adminOnly }));
    if (this.deps.intake === undefined) return void (await interaction.editReply({ content: text.campaign.hub.unavailable }));
    const notes = interaction.fields.getUploadedFiles(fileField, false)?.first();
    await this.deps.intake.authorFrom(this.intakeContext(interaction), {
      idea: interaction.fields.getTextInputValue(ideaField),
      gameLanguage: interaction.fields.getStringSelectValues(languageField)[0] === "zh-TW" ? "zh-TW" : "en",
      notes: notes === undefined ? null : { url: notes.url, size: notes.size },
    });
  }

  // ---- Raise level (Manage) -------------------------------------------------

  private async openLevel(interaction: ButtonInteraction<"cached">, campaignId: string): Promise<void> {
    const record = (await this.deps.lobby.get({ guildId: interaction.guildId, campaignId }))?.record;
    if (record === undefined) {
      await interaction.reply({ content: texts.en.campaign.manage.gone, flags: MessageFlags.Ephemeral });
      return;
    }
    const text = texts[record.language];
    if (!(await this.deps.authority.canManage(interaction, record))) {
      await interaction.reply({ content: text.campaign.manage.notAllowed, flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(hubCustomId("levelSubmit", campaignId))
        .setTitle(text.campaign.hub.levelTitle)
        .addLabelComponents(
          new LabelBuilder()
            .setLabel(text.campaign.hub.levelLabel)
            .setTextInputComponent(new TextInputBuilder().setCustomId(levelField).setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setPlaceholder(text.campaign.hub.levelPlaceholder)),
        ),
    );
  }

  private async submitLevel(interaction: ModalSubmitInteraction<"cached">, campaignId: string): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const record = (await this.deps.lobby.get({ guildId: interaction.guildId, campaignId }))?.record;
    if (record === undefined) return void (await interaction.editReply({ content: texts.en.campaign.manage.gone }));
    const text = texts[record.language];
    // Checked again here: the form is only a request.
    if (!(await this.deps.authority.canManage(interaction, record))) return void (await interaction.editReply({ content: text.campaign.manage.notAllowed }));
    const level = Number(interaction.fields.getTextInputValue(levelField).trim());
    // A DnD Admin acts for the organizer: no user is named, so the engine sees the organizer.
    const result = await this.deps.play.raiseLevel(record.key, null, Number.isInteger(level) ? level : 0, interaction.id);
    await interaction.editReply({ content: result.kind === "ok" ? text.campaign.cmd.levelRaised({ level }) : refusalText(text, result.reason) });
  }

  // ---- Face a hazard (Manage) -------------------------------------------------

  private async openHazard(interaction: ButtonInteraction<"cached">, campaignId: string): Promise<void> {
    const record = (await this.deps.lobby.get({ guildId: interaction.guildId, campaignId }))?.record;
    if (record === undefined) {
      await interaction.reply({ content: texts.en.campaign.manage.gone, flags: MessageFlags.Ephemeral });
      return;
    }
    const text = texts[record.language];
    if (!(await this.deps.authority.canManage(interaction, record))) {
      await interaction.reply({ content: text.campaign.manage.notAllowed, flags: MessageFlags.Ephemeral });
      return;
    }
    const heroes = await this.deps.play.livingHeroes(record.key);
    const t = text.campaign.hub;
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(hubCustomId("hazardSubmit", campaignId))
        .setTitle(t.hazardTitle)
        .addLabelComponents(
          new LabelBuilder()
            .setLabel(t.hazardWho)
            .setStringSelectMenuComponent(
              new StringSelectMenuBuilder()
                .setCustomId(whoField)
                .setRequired(true)
                .addOptions([{ label: t.hazardEveryone, value: "party", default: true }, ...heroes.slice(0, 24).map((hero) => ({ label: hero.name.slice(0, 100), value: hero.id }))]),
            ),
          new LabelBuilder()
            .setLabel(t.hazardAbility)
            .setStringSelectMenuComponent(
              new StringSelectMenuBuilder()
                .setCustomId(abilityField)
                .setRequired(true)
                .addOptions(abilities.map((ability) => ({ label: text.campaign.ability[ability], value: ability, default: ability === "con" }))),
            ),
          new LabelBuilder().setLabel(t.hazardDc).setTextInputComponent(new TextInputBuilder().setCustomId(dcField).setStyle(TextInputStyle.Short).setRequired(true).setMinLength(1).setMaxLength(2).setPlaceholder("15")),
        ),
    );
  }

  private async submitHazard(interaction: ModalSubmitInteraction<"cached">, campaignId: string): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const record = (await this.deps.lobby.get({ guildId: interaction.guildId, campaignId }))?.record;
    if (record === undefined) return void (await interaction.editReply({ content: texts.en.campaign.manage.gone }));
    const text = texts[record.language];
    // Checked again here: the form is only a request.
    if (!(await this.deps.authority.canManage(interaction, record))) return void (await interaction.editReply({ content: text.campaign.manage.notAllowed }));
    const who = interaction.fields.getStringSelectValues(whoField)[0] ?? "party";
    const chosen = interaction.fields.getStringSelectValues(abilityField)[0] ?? "";
    const ability = abilities.find((candidate) => candidate === chosen);
    const dc = Number(interaction.fields.getTextInputValue(dcField).trim());
    const result = ability === undefined ? ({ kind: "refused", reason: "invalidHazard" } as const) : await this.deps.play.hazard(record.key, null, who, ability, dc, interaction.id);
    await interaction.editReply({ content: result.kind === "ok" ? text.campaign.cmd.hazardSet : refusalText(text, result.reason) });
  }

  // ---- Hurt a hero between fights (Manage) ------------------------------------

  private async openHurt(interaction: ButtonInteraction<"cached">, campaignId: string): Promise<void> {
    const record = (await this.deps.lobby.get({ guildId: interaction.guildId, campaignId }))?.record;
    if (record === undefined) {
      await interaction.reply({ content: texts.en.campaign.manage.gone, flags: MessageFlags.Ephemeral });
      return;
    }
    const text = texts[record.language];
    if (!(await this.deps.authority.canManage(interaction, record))) {
      await interaction.reply({ content: text.campaign.manage.notAllowed, flags: MessageFlags.Ephemeral });
      return;
    }
    const heroes = await this.deps.play.livingHeroes(record.key);
    const t = text.campaign.hub;
    await interaction.showModal(
      new ModalBuilder()
        .setCustomId(hubCustomId("hurtSubmit", campaignId))
        .setTitle(t.hurtTitle)
        .addLabelComponents(
          new LabelBuilder()
            .setLabel(t.hazardWho)
            .setStringSelectMenuComponent(
              new StringSelectMenuBuilder()
                .setCustomId(whoField)
                .setRequired(true)
                .addOptions([{ label: t.hazardEveryone, value: "party", default: true }, ...heroes.slice(0, 24).map((hero) => ({ label: hero.name.slice(0, 100), value: hero.id }))]),
            ),
          new LabelBuilder()
            .setLabel(t.hurtWhat)
            .setStringSelectMenuComponent(
              new StringSelectMenuBuilder()
                .setCustomId(kindField)
                .setRequired(true)
                .addOptions(hurtKinds.map((kind) => ({ label: t.hurtKind[kind], value: kind, default: kind === "fall" }))),
            ),
          new LabelBuilder().setLabel(t.hurtAmount).setTextInputComponent(new TextInputBuilder().setCustomId(amountField).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(3).setPlaceholder("20")),
        ),
    );
  }

  private async submitHurt(interaction: ModalSubmitInteraction<"cached">, campaignId: string): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const record = (await this.deps.lobby.get({ guildId: interaction.guildId, campaignId }))?.record;
    if (record === undefined) return void (await interaction.editReply({ content: texts.en.campaign.manage.gone }));
    const text = texts[record.language];
    if (!(await this.deps.authority.canManage(interaction, record))) return void (await interaction.editReply({ content: text.campaign.manage.notAllowed }));
    const who = interaction.fields.getStringSelectValues(whoField)[0] ?? "party";
    const kind = interaction.fields.getStringSelectValues(kindField)[0] ?? "";
    const amount = Number(interaction.fields.getTextInputValue(amountField).trim());
    const result = await this.deps.play.hurt(record.key, null, who, kind, amount, interaction.id);
    await interaction.editReply({ content: result.kind === "ok" ? text.campaign.cmd.hurtSet : refusalText(text, result.reason) });
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
    await interaction.reply({ ...this.screen(defaultWizardChoices, interaction.guildId), flags: MessageFlags.Ephemeral });
  }

  private async chooseOption(interaction: StringSelectMenuInteraction<"cached">, action: "wizLanguage" | "wizPacing" | "wizPlayers" | "wizLoot", state: string | undefined): Promise<void> {
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
          : action === "wizLoot"
            ? { ...current, loot: value === "split" ? "split" : "pooled" }
            : { ...current, players: parseWizardState(`en.live.${value}`).players };
    await interaction.update(this.screen(next, interaction.guildId));
  }

  private async toggleVisibility(interaction: ButtonInteraction<"cached">, state: string | undefined): Promise<void> {
    const current = parseWizardState(state);
    if (!(await this.deps.authority.isAdmin(interaction))) {
      await interaction.update({ content: texts[current.language].campaign.wizard.notAllowed, components: [] });
      return;
    }
    await interaction.update(this.screen({ ...current, visibility: current.visibility === "open" ? "membersOnly" : "open" }, interaction.guildId));
  }

  // Steps through the adventures the server can start from, the bundled one first.
  private async cycleAdventure(interaction: ButtonInteraction<"cached">, state: string | undefined): Promise<void> {
    const current = parseWizardState(state);
    if (!(await this.deps.authority.isAdmin(interaction))) {
      await interaction.update({ content: texts[current.language].campaign.wizard.notAllowed, components: [] });
      return;
    }
    const ids = (this.deps.adventures?.listForGuild(interaction.guildId) ?? []).map((entry) => entry.id);
    const at = ids.indexOf(current.adventure ?? ids[0] ?? "");
    const next = ids[(at + 1) % Math.max(ids.length, 1)];
    await interaction.update(this.screen({ ...current, adventure: next === undefined || next === ids[0] ? null : next }, interaction.guildId));
  }

  // The wizard, with the adventure's title and a way to change it when the server has more than one.
  private screen(choices: WizardChoices, guildId: string): Screen {
    const list = this.deps.adventures?.listForGuild(guildId) ?? [];
    const titleOf = (id: string | null): string | null => {
      const entry = list.find((candidate) => candidate.id === (id ?? list[0]?.id));
      return entry === undefined ? null : (entry.titles[choices.language] ?? entry.titles.en ?? entry.titles["zh-TW"] ?? entry.id);
    };
    return wizardScreen(choices, list.length > 1 ? titleOf(choices.adventure) : null);
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

  private async chooseInvitee(interaction: ButtonInteraction<"cached">, campaignId: string): Promise<void> {
    const record = (await this.deps.lobby.get({ guildId: interaction.guildId, campaignId }))?.record;
    if (record === undefined || record.organizerId !== interaction.user.id || record.lifecycle === "lobby" || record.lifecycle === "archived") return void (await interaction.reply({ content: "Only the organizer can invite players into a running game.", flags: MessageFlags.Ephemeral }));
    await interaction.reply({ content: record.language === "zh-TW" ? "選擇要邀請的玩家。" : "Select the player to invite.", components: [new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(new UserSelectMenuBuilder().setCustomId(hubCustomId("inviteUser", campaignId)).setMaxValues(1))], flags: MessageFlags.Ephemeral });
  }

  private async openJoinForm(interaction: ButtonInteraction<"cached"> | import("discord.js").UserSelectMenuInteraction<"cached">, campaignId: string, action: "inviteOpen" | "joinApproveOpen", userId?: string): Promise<void> {
    const record = (await this.deps.lobby.get({ guildId: interaction.guildId, campaignId }))?.record;
    if (record === undefined || record.organizerId !== interaction.user.id || record.lifecycle === "lobby" || record.lifecycle === "archived") {
      await interaction.reply({ content: "Only the organizer can manage joining for a running game.", flags: MessageFlags.Ephemeral });
      return;
    }
    const zh = record.language === "zh-TW";
    const modal = new ModalBuilder().setCustomId(hubCustomId(action === "inviteOpen" ? "inviteSubmit" : "joinApproveSubmit", campaignId, ...(userId === undefined ? [] : [userId]))).setTitle(zh ? "安排新角色加入" : "Bring in a new character");
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(entranceField).setLabel(zh ? "角色登場方式" : "How the character enters the story").setStyle(TextInputStyle.Paragraph).setMaxLength(500).setRequired(true)));
    await interaction.showModal(modal);
  }

  private async submitJoinForm(interaction: ModalSubmitInteraction<"cached">, campaignId: string, action: "inviteSubmit" | "joinApproveSubmit", approvedUserId?: string): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const key: CampaignKey = { guildId: interaction.guildId, campaignId };
    const record = (await this.deps.lobby.get(key))?.record;
    if (record === undefined || record.organizerId !== interaction.user.id) return void (await interaction.editReply({ content: "Only the organizer can manage joining." }));
    const userId = approvedUserId ?? "";
    if (!/^\d{15,22}$/.test(userId)) return void (await interaction.editReply({ content: record.language === "zh-TW" ? "請輸入有效的 Discord 使用者 ID。" : "Enter a valid Discord user ID." }));
    const entrance = interaction.fields.getTextInputValue(entranceField);
    const result = action === "inviteSubmit" ? await this.deps.lobby.inviteOngoing(key, interaction.user.id, userId, entrance) : await this.deps.lobby.decideOngoingJoin(key, interaction.user.id, userId, true, entrance);
    if (result.kind === "refused") return void (await interaction.editReply({ content: refusalText(texts[record.language], result.reason) }));
    const access = await this.deps.setup.applyVisibility(key);
    const party = result.value.channels.partyPostId;
    const link = party === null ? "" : ` https://discord.com/channels/${key.guildId}/${party}`;
    const notified = await interaction.client.users.fetch(userId).then((user) => user.send(record.language === "zh-TW" ? `你已受邀／獲准加入「${record.name}」。請到隊伍頻道按「申請／加入遊戲」並選擇角色。${link}` : `You're invited or approved to join ${record.name}. Open the Party post, press “Request / join game,” and choose a character.${link}`)).then(() => true).catch(() => false);
    await interaction.editReply({ content: record.language === "zh-TW" ? `<@${userId}> 已獲准加入。${notified ? "已發送私訊。" : "私訊未送達，請直接告知玩家。"}${access.kind === "failed" ? " 私人頻道權限需修復。" : ""}` : `<@${userId}> may join. ${notified ? "I sent them a DM." : "The DM could not be delivered; please tell them directly."}${access.kind === "failed" ? " Private-channel access needs repair." : ""}` });
  }

  private async showJoinRequests(interaction: ButtonInteraction<"cached">, campaignId: string): Promise<void> {
    const found = await this.allowed(interaction, campaignId);
    if (found === null) return;
    const pending = Object.entries(found.record.joinRequests ?? {}).filter(([, request]) => request.status === "requested" && request.expiresAt > Date.now()).slice(0, 4);
    await interaction.update({
      content: pending.length === 0 ? (found.record.language === "zh-TW" ? "目前沒有待審申請。" : "No pending applications.") : pending.map(([userId]) => `<@${userId}>`).join("\n"),
      components: pending.map(([userId]) => row(
        new ButtonBuilder().setCustomId(hubCustomId("joinApproveOpen", campaignId, userId)).setLabel(found.record.language === "zh-TW" ? `批准 ${userId}` : `Approve ${userId}`).setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(hubCustomId("joinDecline", campaignId, userId)).setLabel(found.record.language === "zh-TW" ? "拒絕" : "Decline").setStyle(ButtonStyle.Secondary),
      )),
    });
  }

  private async declineJoin(interaction: ButtonInteraction<"cached">, campaignId: string, userId: string): Promise<void> {
    const found = await this.allowed(interaction, campaignId);
    if (found === null) return;
    const result = await this.deps.lobby.decideOngoingJoin(found.record.key, interaction.user.id, userId, false);
    await interaction.update({ content: result.kind === "refused" ? refusalText(found.text, result.reason) : (found.record.language === "zh-TW" ? "已拒絕申請。" : "Application declined."), components: [] });
  }

  private async runManage(interaction: ButtonInteraction<"cached">, campaignId: string, verb: string | undefined): Promise<void> {
    const found = await this.allowed(interaction, campaignId);
    if (found === null) return;
    const { record, text } = found;
    let notice = "";
    if (verb === "repair") {
      await interaction.deferUpdate();
      notice = repairText(await this.deps.setup.repair(record.key), text);
    } else if (verb === "redoPicture") {
      await interaction.deferUpdate();
      const result = await this.deps.play.redoPicture(record.key, record.lastPicture ?? "", interaction.id);
      notice = result.kind === "ok" ? text.campaign.cmd.pictureRedone : refusalText(text, result.reason);
    } else if (isManageVerb(verb) && verb !== "repair" && verb !== "redoPicture") {
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
    const paused = mode === "paused" || mode === "recovery" || mode === "safety";
    const status = mode === null ? "" : text.campaign.mode[mode];
    const id = record.key.campaignId;
    const verb = (action: ManageVerb, label: string): ButtonBuilder => new ButtonBuilder().setCustomId(hubCustomId("do", id, action)).setLabel(label).setStyle(ButtonStyle.Secondary);
    const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    if (record.lifecycle !== "lobby") {
      rows.push(
        row(
          paused ? verb("resume", t.resume).setStyle(ButtonStyle.Success) : verb("pause", t.pause),
          verb("closeRound", t.closeRound),
          verb("retry", t.retry),
          verb("redoPicture", t.redoPicture),
          new ButtonBuilder().setCustomId(hubCustomId("levelOpen", id)).setLabel(t.levelButton).setStyle(ButtonStyle.Secondary),
        ),
        row(verb("shortRest", t.shortRest), verb("longRest", t.longRest), verb("retryFight", t.retryFight), verb("retell", t.retell), verb("illustrate", t.illustrate)),
      );
      const pendingCount = Object.values(record.joinRequests ?? {}).filter((request) => request.status === "requested" && request.expiresAt > Date.now()).length;
      rows.push(row(
        new ButtonBuilder().setCustomId(hubCustomId("inviteOpen", id)).setLabel(record.language === "zh-TW" ? "邀請玩家" : "Invite player").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(hubCustomId("joinRequests", id)).setLabel(record.language === "zh-TW" ? `加入申請 (${pendingCount})` : `Join requests (${pendingCount})`).setStyle(ButtonStyle.Secondary),
      ));
    }
    rows.push(
      row(
        verb("repair", t.repair),
        ...(record.lifecycle === "lobby"
          ? []
          : [
              new ButtonBuilder().setCustomId(hubCustomId("hazardOpen", id)).setLabel(t.hazardButton).setStyle(ButtonStyle.Secondary),
              new ButtonBuilder().setCustomId(hubCustomId("hurtOpen", id)).setLabel(t.hurtButton).setStyle(ButtonStyle.Secondary),
            ]),
        new ButtonBuilder().setCustomId(hubCustomId("endAsk", id)).setLabel(t.end).setStyle(ButtonStyle.Danger),
      ),
    );
    const problems = (record.issues ?? []).map((issue) => `⚠️ ${text.campaign.issue.short[issue.code]({ detail: issue.detail })}`);
    const title = `**${t.title({ name: record.name })}**${status === "" ? "" : ` · ${status}`}`;
    return { content: problems.length === 0 ? title : `${title}\n${t.needsAttention}\n${problems.join("\n")}`, components: rows };
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
    case "retryFight":
      return t.fightRetried;
    case "retell":
      return t.retold;
    case "illustrate":
      return t.illustrated;
    case "redoPicture":
      return t.pictureRedone;
    case "shortRest":
    case "longRest":
      return t.rested;
    case "repair":
      return t.repaired;
  }
}

// The wizard: the choices so far live in each control's custom ID.
// `adventureTitle` is null when there is only the bundled adventure to choose.
function wizardScreen(choices: WizardChoices, adventureTitle: string | null): Screen {
  const text = texts[choices.language];
  const t = text.campaign.wizard;
  const state = wizardState(choices);
  const select = (action: "wizLanguage" | "wizPacing" | "wizPlayers" | "wizLoot", placeholder: string, options: readonly { label: string; value: string; selected: boolean }[]): ActionRowBuilder<MessageActionRowComponentBuilder> =>
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(hubCustomId(action, state))
        .setPlaceholder(placeholder)
        .addOptions(options.map((option) => ({ label: option.label, value: option.value, default: option.selected }))),
    );
  const language = choices.language === "en" ? text.campaign.language.en : text.campaign.language.zhTW;
  const pacing = choices.pacing === "live" ? text.campaign.pacing.live : text.campaign.pacing.playByPost;
  return {
    content: `**${t.title}**\n${t.intro}\n\n${t.summary({ language, pacing, count: choices.players, loot: choices.loot === "split" ? t.lootSplit : t.lootPooled })}\n${t.visibilityLine({ who: choices.visibility === "membersOnly" ? t.visibilityPlayers : t.visibilityOpen })}${adventureTitle === null ? "" : `\n${text.campaign.adventure.wizardLine({ title: adventureTitle })}`}`,
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
      select("wizLoot", t.lootPlaceholder, [
        { label: t.lootPooled, value: "pooled", selected: choices.loot === "pooled" },
        { label: t.lootSplit, value: "split", selected: choices.loot === "split" },
      ]),
      row(
        new ButtonBuilder().setCustomId(hubCustomId("wizNext", state)).setLabel(t.next).setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId(hubCustomId("wizVisibility", state))
          .setLabel(choices.visibility === "membersOnly" ? t.visibilityButtonPlayers : t.visibilityButtonOpen)
          .setStyle(ButtonStyle.Secondary),
        ...(adventureTitle === null
          ? []
          : [new ButtonBuilder().setCustomId(hubCustomId("wizAdventure", state)).setLabel(text.campaign.adventure.wizardButton({ title: adventureTitle }).slice(0, 80)).setStyle(ButtonStyle.Secondary)]),
      ),
    ],
  };
}
