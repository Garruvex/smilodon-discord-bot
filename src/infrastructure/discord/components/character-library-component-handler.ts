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

import { maxCharactersPerOwner, maxImportBytes, type CharacterLibrary } from "../../../application/campaign/library/character-library.js";
import { isPortraitStyle, maxUploadBytes, type CharacterPortraits, type PortraitResult } from "../../../application/campaign/library/character-portraits.js";
import type { ImportConflict } from "../../../application/campaign/library/compatibility.js";
import type { LibrarySnapshot } from "../../../application/campaign/library/library-types.js";
import { CommandModule } from "../../../application/commands/command.js";
import type { ComponentContext, ComponentHandler, ModalContext } from "../../../application/components/component-handler.js";
import { texts, type Texts } from "../../../application/i18n/texts.js";
import { publicAccessPolicy } from "../../../domain/access/access-policy.js";
import { deriveSnapshotSheet } from "../../../domain/campaign/character/leveling.js";
import { buildClasses, buildRaces, classTemplates, selectableBuildRaces, suggestedAbilities, type BuildChoices, type BuildProblem } from "../../../domain/campaign/character/character-build.js";
import { abilityModifier, skillAbilities, type CharacterSheet, type Skill } from "../../../domain/campaign/character/character-sheet.js";
import { armorClassFrom, heroTraits, unarmoredModifier } from "../../../domain/campaign/combat/combatant-profile.js";
import type { Glossary, SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import { abilities, type Ability } from "../../../domain/campaign/rules/effects.js";
import { isSkill, skills } from "../../../domain/campaign/rules/skills.js";
import { classLabel, skillKey } from "../campaign/text-keys.js";
import { downloadAttachmentBytes, downloadAttachmentText, type BytesResult } from "../campaign/attachment-download.js";
import { fileField, noteField, portraitHome, portraitModal, portraitPreview, portraitRefused, portraitWorking, styleField, type PortraitScreen } from "../campaign/portrait-screens.js";
import { decodeDraft, emptyDraft, encodeDraft, libraryCustomId, libraryIdPrefix, parseLibraryId, scoresOf, type Draft, withLanguage } from "../campaign/library-ids.js";

export interface CharacterLibraryHandlerDependencies {
  readonly library: CharacterLibrary;
  readonly content: SealedContent;
  readonly glossaries: Readonly<Record<string, Glossary>>;
  // Portraits for saved characters; absent: the screens do not offer them.
  readonly portraits?: CharacterPortraits;
  // Reads an uploaded picture (a test can hand it over directly).
  readonly downloadImage?: (url: string, maxBytes: number) => Promise<BytesResult>;
  // Redraw game cards that use this saved character when its accepted portrait changes.
  readonly onPortraitChanged?: (characterId: string) => Promise<void>;
}

type Row = ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>;
export interface LibraryScreen {
  readonly content: string;
  readonly components: Row[];
  // A picture shown with the screen (a character's portrait).
  readonly files?: PortraitScreen["files"];
}

type Language = "en" | "zh-TW";
// The language of a person's own Discord client: the library belongs to the
// person, not to any one server or game.
export const languageOf = (interaction: { readonly locale: string }): Language => (interaction.locale.startsWith("zh") ? "zh-TW" : "en");

// A form remembers the language too, so the screen after it is in the same one.
function speakModal(modal: ModalBuilder, language: Language): ModalBuilder {
  const id = modal.data.custom_id;
  return typeof id === "string" ? modal.setCustomId(withLanguage(id, language)) : modal;
}

// Every control on a screen remembers the language the screen is in.
function speak(screen: LibraryScreen, language: Language): LibraryScreen {
  for (const row of screen.components) {
    for (const component of row.components) {
      const id = "custom_id" in component.data ? component.data.custom_id : undefined;
      if (typeof id === "string" && id.startsWith(`${libraryIdPrefix}:`) && parseLibraryId(id)?.language === undefined) component.setCustomId(withLanguage(id, language));
    }
  }
  return screen;
}

const nameField = "name";
const appearanceField = "appearance";
const backstoryField = "backstory";

// The character library's private screens (plan §3, My Characters): the list,
// one character with its saved versions, the guided builder, export and
// delete. Every screen is for the user who opened it and every click is
// checked against that user's own library; the builder keeps its choices in
// the controls' IDs, so nothing is stored until the character is named.
export class CharacterLibraryComponentHandler implements ComponentHandler {
  public readonly customIdPrefix = libraryIdPrefix;
  public readonly module = CommandModule.Campaign;
  public readonly access = publicAccessPolicy;

  public constructor(private readonly deps: CharacterLibraryHandlerDependencies) {}

  // The opening screen, for /dnd characters.
  public async homeScreen(userId: string, language: Language): Promise<LibraryScreen> {
    return speak(await this.home(userId, language), language);
  }

  private async home(userId: string, language: Language): Promise<LibraryScreen> {
    const text = texts[language];
    const entries = await this.deps.library.list(userId);
    const t = text.campaign.chars;
    const rows: Row[] = [];
    if (entries.length > 0) {
      rows.push(
        new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(libraryCustomId("view"))
            .setPlaceholder(t.pickPlaceholder)
            .addOptions(entries.map((entry) => ({ label: `${entry.character.name} — ${classLabel(text, entry.character.className)}`.slice(0, 100), value: entry.character.id }))),
        ),
      );
    }
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(
        button(libraryCustomId("new"), t.newButton, ButtonStyle.Primary, entries.length >= maxCharactersPerOwner),
        button(libraryCustomId("lang", language === "en" ? "zh-TW" : "en"), t.switchLanguage, ButtonStyle.Secondary),
      ),
    );
    const lines = entries.map((entry) => t.line({ name: entry.character.name, class: classLabel(text, entry.character.className), count: entry.snapshots.length }));
    return { content: `**${t.title}**\n${t.intro}\n\n${lines.length === 0 ? t.empty : lines.join("\n")}`, components: rows };
  }

  // The builder's first screen (choose a class), for the hub's New character button.
  public builderScreen(language: Language): LibraryScreen {
    return speak(this.classScreen(texts[language]), language);
  }

  // Reads an uploaded character file as data and makes it a new character in
  // the person's library, or says exactly why it cannot. Shared by
  // /dnd import-character and the hub's Import character form.
  public async importFromFile(userId: string, language: Language, file: { readonly url: string; readonly size: number } | null): Promise<string> {
    const text = texts[language];
    const words = text.campaign.chars;
    if (file === null) return words.importNeedsFile;
    // Only a file uploaded to Discord, and only a small one.
    if (file.size > maxImportBytes) return words.importUnreadable.tooLarge;
    const fetched = await downloadAttachmentText(file.url, maxImportBytes);
    if (!fetched.ok) return fetched.reason === "notDiscord" ? words.importBadLink : fetched.reason === "tooLarge" ? words.importUnreadable.tooLarge : words.importUnreadable.notJson;
    const result = await this.deps.library.import(userId, fetched.text);
    switch (result.kind) {
      case "ok":
        return words.imported({ name: result.character.name, sheet: this.sheetLine(result.snapshot, text) });
      case "unreadable":
        return words.importUnreadable[result.reason];
      case "conflicts":
        return [words.importConflicts, ...conflictLines(result.conflicts, text).map((line) => `• ${line}`)].join("\n");
      case "full":
        return words.full({ max: maxCharactersPerOwner });
    }
  }

  public async execute(context: ComponentContext): Promise<void> {
    const { interaction } = context;
    const parsed = parseLibraryId(interaction.customId);
    if (parsed === null) return;
    const language = parsed.language ?? languageOf(interaction);
    const text = texts[language];
    const userId = interaction.user.id;
    const [first] = parsed.parts;

    if (interaction.isStringSelectMenu()) {
      await interaction.deferUpdate();
      const value = interaction.values[0] ?? "";
      switch (parsed.action) {
        case "view":
          return void (await this.show(interaction, await this.viewScreen(userId, value, language)));
        case "bClass":
          return void (await this.show(interaction, this.raceScreen({ ...emptyDraft, class: buildClasses.find((id) => id === value) ?? null }, language)));
        case "bRace": {
          const draft = decodeDraft(first);
          const race = buildRaces.find((id) => id === value) ?? null;
          const chosen = { ...draft, race, raceAbilities: [], raceSkills: [] };
          return void (await this.show(interaction, race === "half-elf" ? this.raceAbilityScreen(chosen, text) : this.kitScreen(chosen, text)));
        }
        case "bRaceAbility": {
          const draft = decodeDraft(first);
          const ability = abilities.find((candidate) => candidate === value && candidate !== "cha" && !draft.raceAbilities.includes(candidate));
          const chosen = ability === undefined ? draft : { ...draft, raceAbilities: [...draft.raceAbilities, ability] };
          return void (await this.show(interaction, chosen.raceAbilities.length === 2 ? this.raceSkillScreen(chosen, text) : this.raceAbilityScreen(chosen, text)));
        }
        case "bRaceSkills": {
          const draft = decodeDraft(first);
          const raceSkills = interaction.values.filter((skill): skill is Draft["raceSkills"][number] => isSkill(skill)).slice(0, 2);
          return void (await this.show(interaction, this.kitScreen({ ...draft, raceSkills }, text)));
        }
        case "bKit":
          return void (await this.show(interaction, this.skillsScreen({ ...decodeDraft(first), kit: value }, language)));
        case "bSkills": {
          const draft = decodeDraft(first);
          const chosen = { ...draft, skills: interaction.values.flatMap((skill) => (classTemplates[draft.class ?? "fighter"].skillChoices as readonly string[]).includes(skill) && !(draft.raceSkills as readonly string[]).includes(skill) ? [skill as Draft["skills"][number]] : []), expertise: [] };
          const needsExpertise = draft.class !== null && classTemplates[draft.class].expertiseCount > 0;
          return void (await this.show(interaction, needsExpertise ? this.expertiseScreen(chosen, language) : this.scoresScreen(chosen, language)));
        }
        case "bExpert": {
          const draft = decodeDraft(first);
          const expertise = interaction.values.flatMap((skill) => (draft.skills as readonly string[]).includes(skill) ? [skill as Draft["skills"][number]] : []);
          return void (await this.show(interaction, this.scoresScreen({ ...draft, expertise }, language)));
        }
        case "bScore": {
          const draft = decodeDraft(first);
          const ability = abilities.find((candidate) => candidate === value);
          const next = ability === undefined || draft.order.includes(ability) ? draft : { ...draft, order: [...draft.order, ability] };
          return void (await this.show(interaction, this.scoresScreen(next, language)));
        }
        case "pStyle":
          return void (await this.repaint(interaction, userId, first ?? "", language, isPortraitStyle(value) ? value : undefined));
        default:
          return;
      }
    }
    if (!interaction.isButton()) return;
    switch (parsed.action) {
      case "lang":
        await interaction.deferUpdate();
        return void (await this.show(interaction, speak(await this.home(userId, first === "zh-TW" ? "zh-TW" : "en"), first === "zh-TW" ? "zh-TW" : "en")));
      case "home":
        await interaction.deferUpdate();
        return void (await this.show(interaction, await this.homeScreen(userId, language)));
      case "view":
        await interaction.deferUpdate();
        return void (await this.show(interaction, await this.viewScreen(userId, first ?? "", language)));
      case "new":
        await interaction.deferUpdate();
        return void (await this.show(interaction, this.classScreen(text)));
      case "bRecommended": {
        await interaction.deferUpdate();
        const draft = decodeDraft(first);
        const order = draft.class === null ? [] : classTemplates[draft.class].suggested.slice(0, 5);
        return void (await this.show(interaction, this.scoresScreen({ ...draft, order }, language)));
      }
      case "bName":
        // A form has to be the first response.
        return void (await interaction.showModal(speakModal(this.nameModal(first ?? "", text), language)));
      case "pUpload":
        return void (await interaction.showModal(speakModal(portraitModal(text, first ?? ""), language)));
      case "pHome":
        await interaction.deferUpdate();
        return void (await this.show(interaction, await this.portraitHomeFor(userId, first ?? "", language)));
      case "pPaint": {
        await interaction.deferUpdate();
        const characterId = first ?? "";
        const name = (await this.deps.library.entry(userId, characterId))?.character.name ?? "";
        await this.show(interaction, portraitWorking(text, name));
        const result = (await this.deps.portraits?.fromDescription(userId, characterId, "painterly", "")) ?? ({ kind: "refused", reason: "unavailable" } as const);
        return void (await this.show(interaction, await this.portraitResult(userId, characterId, language, result)));
      }
      case "pRetry":
        await interaction.deferUpdate();
        return void (await this.repaint(interaction, userId, first ?? "", language, undefined));
      case "pUse": {
        await interaction.deferUpdate();
        const characterId = first ?? "";
        const saved = (await this.deps.portraits?.accept(userId, characterId)) === true;
        const name = (await this.deps.library.entry(userId, characterId))?.character.name ?? "";
        if (!saved) return void (await this.show(interaction, await this.portraitHomeFor(userId, characterId, language)));
        await this.deps.onPortraitChanged?.(characterId);
        return void (await this.show(interaction, await this.viewScreen(userId, characterId, language, text.campaign.portrait.saved({ name }))));
      }
      case "pDrop":
        await interaction.deferUpdate();
        await this.deps.portraits?.discard(userId, first ?? "");
        return void (await this.show(interaction, await this.portraitHomeFor(userId, first ?? "", language)));
      case "pRemove":
        await interaction.deferUpdate();
        await this.deps.portraits?.remove(userId, first ?? "");
        await this.deps.onPortraitChanged?.(first ?? "");
        return void (await this.show(interaction, await this.portraitHomeFor(userId, first ?? "", language, text.campaign.portrait.removed)));
      case "export":
        await interaction.deferUpdate();
        return void (await this.exportFile(interaction, userId, first ?? "", text));
      case "deleteAsk": {
        await interaction.deferUpdate();
        const entry = await this.deps.library.entry(userId, first ?? "");
        if (entry === undefined) return void (await this.show(interaction, { content: text.campaign.chars.gone, components: [] }));
        return void (await this.show(interaction, {
          content: text.campaign.chars.deleteAsk({ name: entry.character.name }),
          components: [
            new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(
              button(libraryCustomId("deleteYes", entry.character.id), text.campaign.chars.deleteYes, ButtonStyle.Danger),
              button(libraryCustomId("view", entry.character.id), text.campaign.chars.backButton, ButtonStyle.Secondary),
            ),
          ],
        }));
      }
      case "deleteYes": {
        await interaction.deferUpdate();
        const entry = await this.deps.library.entry(userId, first ?? "");
        const removed = entry !== undefined && (await this.deps.library.remove(userId, entry.character.id));
        if (removed && entry !== undefined) await this.deps.portraits?.forget(entry.character.id);
        const home = await this.homeScreen(userId, language);
        return void (await this.show(interaction, { content: `${removed && entry !== undefined ? text.campaign.chars.deleted({ name: entry.character.name }) : text.campaign.chars.gone}\n\n${home.content}`, components: home.components }));
      }
      default:
        return;
    }
  }

  // The name form: the character is made from the builder's choices and saved.
  public async executeModal(context: ModalContext): Promise<void> {
    const { interaction } = context;
    const parsed = parseLibraryId(interaction.customId);
    if (parsed?.action === "pSubmit") return void (await this.submitPortrait(interaction, parsed.parts[0] ?? "", parsed.language ?? languageOf(interaction)));
    if (parsed?.action !== "bName") return;
    const language = parsed.language ?? languageOf(interaction);
    const text = texts[language];
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const draft = decodeDraft(parsed.parts[0]);
    const build = this.buildFrom(draft, {
      name: interaction.fields.getTextInputValue(nameField),
      appearance: interaction.fields.getTextInputValue(appearanceField),
      backstory: interaction.fields.getTextInputValue(backstoryField),
    });
    if (build === null) {
      await interaction.editReply({ content: text.campaign.chars.problem.abilitiesNotStandardArray });
      return;
    }
    const made = await this.deps.library.create(interaction.user.id, build);
    if (made.kind === "invalid") {
      await interaction.editReply({ content: this.problemLines(made.problems, text) });
      return;
    }
    if (made.kind === "full") {
      await interaction.editReply({ content: text.campaign.chars.full({ max: maxCharactersPerOwner }) });
      return;
    }
    const offer = this.deps.portraits?.available === true;
    await interaction.editReply({
      content: text.campaign.chars.created({ name: made.character.name, sheet: this.sheetLine(made.snapshot, text) }) + (offer ? `\n\n${text.campaign.portrait.offer}` : ""),
      components: offer ? speak({ content: "", components: [new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(button(libraryCustomId("pHome", made.character.id), text.campaign.portrait.button, ButtonStyle.Primary), button(libraryCustomId("view", made.character.id), text.campaign.chars.viewButton, ButtonStyle.Secondary))] }, language).components : [],
    });
  }

  // The upload form was sent: read the picture, make the portrait, show it for a yes.
  private async submitPortrait(interaction: ModalSubmitInteraction, characterId: string, language: Language): Promise<void> {
    const text = texts[language];
    const userId = interaction.user.id;
    await interaction.deferUpdate();
    const shown = async (screen: LibraryScreen): Promise<void> => void (await interaction.editReply({ content: screen.content, components: speak(screen, language).components, files: [...(screen.files ?? [])], attachments: [] }));
    const attachment = interaction.fields.getUploadedFiles(fileField, false)?.first();
    if (attachment === undefined) return shown(portraitRefused(text, characterId, "noFile"));
    if (attachment.size > maxUploadBytes) return shown(portraitRefused(text, characterId, "tooLarge"));
    const name = (await this.deps.library.entry(userId, characterId))?.character.name ?? "";
    await shown(portraitWorking(text, name));
    const downloaded = await (this.deps.downloadImage ?? downloadAttachmentBytes)(attachment.url, maxUploadBytes);
    if (!downloaded.ok) return shown(portraitRefused(text, characterId, downloaded.reason === "tooLarge" ? "tooLarge" : "downloadFailed"));
    const chosen = interaction.fields.getStringSelectValues(styleField)[0] ?? "";
    const result = (await this.deps.portraits?.fromUpload(userId, characterId, downloaded.bytes, isPortraitStyle(chosen) ? chosen : "painterly", interaction.fields.getTextInputValue(noteField))) ?? ({ kind: "refused", reason: "unavailable" } as const);
    await shown(await this.portraitResult(userId, characterId, language, result));
  }

  // ---- screens ------------------------------------------------------------

  private async portraitHomeFor(userId: string, characterId: string, language: Language, note?: string): Promise<LibraryScreen> {
    const text = texts[language];
    const portraits = this.deps.portraits;
    const entry = await this.deps.library.entry(userId, characterId);
    if (portraits === undefined || entry === undefined) return { content: text.campaign.chars.gone, components: [] };
    return portraitHome({ text, characterId, name: entry.character.name, current: await portraits.current(userId, characterId), canUpload: portraits.canUpload, canPaint: portraits.canPaint, ...(note === undefined ? {} : { note }) });
  }

  // A made portrait to look at, or the reason there is none.
  private async portraitResult(userId: string, characterId: string, language: Language, result: PortraitResult): Promise<LibraryScreen> {
    const text = texts[language];
    if (result.kind === "refused") return portraitRefused(text, characterId, result.reason, result.retryAfterMinutes);
    const name = (await this.deps.library.entry(userId, characterId))?.character.name ?? "";
    return portraitPreview({ text, characterId, name, style: result.style, image: result.image });
  }

  // Try the candidate again, in the same look or a new one.
  private async repaint(interaction: ButtonInteraction | StringSelectMenuInteraction, userId: string, characterId: string, language: Language, style: Parameters<CharacterPortraits["again"]>[2]): Promise<void> {
    const text = texts[language];
    const name = (await this.deps.library.entry(userId, characterId))?.character.name ?? "";
    await this.show(interaction, portraitWorking(text, name));
    const result = (await this.deps.portraits?.again(userId, characterId, style)) ?? ({ kind: "refused", reason: "unavailable" } as const);
    await this.show(interaction, await this.portraitResult(userId, characterId, language, result));
  }

  private async viewScreen(userId: string, characterId: string, language: Language, note?: string): Promise<LibraryScreen> {
    const text = texts[language];
    const t = text.campaign.chars;
    const entry = await this.deps.library.entry(userId, characterId);
    if (entry === undefined) return { content: t.gone, components: [] };
    const first = entry.snapshots[0];
    const scores = first === undefined ? "" : abilities.map((ability) => `${text.campaign.ability[ability]} ${first.build.abilities[ability]}`).join(" · ");
    const glossary = this.deps.glossaries[language];
    const lines = entry.snapshots.map((snapshot) =>
      t.viewSnapshot({
        revision: snapshot.revision,
        source: snapshot.source.kind === "builder" ? t.sourceBuilder : snapshot.source.kind === "import" ? t.sourceImport : t.sourceCampaign,
        gear: snapshot.gear.equipment.map((id) => glossary?.names[id] ?? id).join(", "),
      }),
    );
    const latest = entry.snapshots.at(-1);
    const race = first?.build.race === undefined ? null : (glossary?.names[`race:${first.build.race}`] ?? first.build.race);
    const heading = `${race === null ? "" : `${race} `}${classLabel(text, entry.character.className)}`;
    const portraits = this.deps.portraits;
    const portrait = portraits === undefined ? undefined : await portraits.current(userId, characterId);
    return {
      content: [...(note === undefined ? [] : [note, ""]), t.viewTitle({ name: entry.character.name, class: heading }), t.viewScores({ scores }), "", ...lines].join("\n"),
      ...(portrait === undefined ? {} : { files: [{ attachment: portrait.bytes, name: `portrait.${portrait.mediaType === "image/jpeg" ? "jpg" : portrait.mediaType === "image/webp" ? "webp" : "png"}` }] }),
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(
          ...(portraits?.available === true ? [button(libraryCustomId("pHome", entry.character.id), text.campaign.portrait.button, portrait === undefined ? ButtonStyle.Primary : ButtonStyle.Secondary)] : []),
          ...(latest === undefined ? [] : [button(libraryCustomId("export", latest.id), t.exportButton, ButtonStyle.Secondary)]),
          button(libraryCustomId("deleteAsk", entry.character.id), t.deleteButton, ButtonStyle.Danger),
          button(libraryCustomId("home"), t.backButton, ButtonStyle.Secondary),
        ),
      ],
    };
  }

  private classScreen(text: Texts): LibraryScreen {
    const t = text.campaign.chars;
    return {
      content: t.bClass,
      components: [select(libraryCustomId("bClass"), t.bClassPlaceholder, buildClasses.map((id) => ({ label: classLabel(text, id), value: id })))],
    };
  }

  private raceScreen(draft: Draft, language: Language): LibraryScreen {
    const text = texts[language];
    const t = text.campaign.chars;
    if (draft.class === null) return this.classScreen(text);
    const glossary = this.deps.glossaries[language];
    const options = selectableBuildRaces.map((race) => ({ label: glossary?.names[`race:${race}`] ?? race, value: race }));
    return { content: t.bRace({ class: classLabel(text, draft.class) }), components: [select(libraryCustomId("bRace", encodeDraft(draft)), t.bRacePlaceholder, options)] };
  }

  private raceAbilityScreen(draft: Draft, text: Texts): LibraryScreen {
    if (draft.race !== "half-elf") return this.kitScreen(draft, text);
    const t = text.campaign.chars;
    const options = abilities.filter((ability) => ability !== "cha" && !draft.raceAbilities.includes(ability)).map((ability) => ({ label: text.campaign.ability[ability], value: ability }));
    return { content: t.bRaceAbility({ count: 2 - draft.raceAbilities.length }), components: [select(libraryCustomId("bRaceAbility", encodeDraft(draft)), t.bRaceAbilityPlaceholder, options)] };
  }

  private raceSkillScreen(draft: Draft, text: Texts): LibraryScreen {
    const t = text.campaign.chars;
    return { content: t.bRaceSkills, components: [select(libraryCustomId("bRaceSkills", encodeDraft(draft)), t.bRaceSkillsPlaceholder, skills.map((skill) => ({ label: text.campaign.skill[skillKey(skill)], value: skill })), 2, 2)] };
  }

  private kitScreen(draft: Draft, text: Texts): LibraryScreen {
    const t = text.campaign.chars;
    if (draft.class === null) return this.classScreen(text);
    const kits = classTemplates[draft.class].kits.map((kit) => ({ label: (t.kit as Readonly<Record<string, string>>)[kit.id] ?? kit.id, value: kit.id }));
    return { content: t.bKit({ class: classLabel(text, draft.class) }), components: [select(libraryCustomId("bKit", encodeDraft(draft)), t.bKitPlaceholder, kits)] };
  }

  private skillsScreen(draft: Draft, language: Language): LibraryScreen {
    const text = texts[language];
    const t = text.campaign.chars;
    if (draft.class === null) return this.classScreen(text);
    const template = classTemplates[draft.class];
    const options = template.skillChoices.filter((skill) => !draft.raceSkills.includes(skill)).map((skill) => ({ label: `${text.campaign.skill[skillKey(skill)]} (${skillAbility(skill)})`, value: skill }));
    return {
      content: t.bSkills({ count: template.skillCount }),
      components: [select(libraryCustomId("bSkills", encodeDraft(draft)), t.bSkillsPlaceholder, options, template.skillCount, template.skillCount)],
    };
  }

  private expertiseScreen(draft: Draft, language: Language): LibraryScreen {
    const text = texts[language];
    const t = text.campaign.chars;
    if (draft.class === null) return this.classScreen(text);
    const count = classTemplates[draft.class].expertiseCount;
    const options = draft.skills.map((skill) => ({ label: text.campaign.skill[skillKey(skill)], value: skill }));
    return { content: t.bExpert({ count }), components: [select(libraryCustomId("bExpert", encodeDraft(draft)), t.bExpertPlaceholder, options, count, count)] };
  }

  // Deals the standard array out ability by ability, or all at once with the suggestion.
  private scoresScreen(draft: Draft, language: Language): LibraryScreen {
    const text = texts[language];
    const t = text.campaign.chars;
    if (draft.class === null) return this.classScreen(text);
    const token = encodeDraft(draft);
    if (draft.order.length >= abilities.length - 1) {
      const scores = scoresOf(draft.order);
      const done = abilities.map((ability) => `${text.campaign.ability[ability]} ${scores[ability] ?? 0}`).join(" · ");
      return {
        content: t.bScoresDone({ scores: done }),
        components: [new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(button(libraryCustomId("bName", encodeDraft({ ...draft, order: this.fullOrder(draft.order) })), t.bNameButton, ButtonStyle.Primary))],
      };
    }
    const value = [15, 14, 13, 12, 10, 8][draft.order.length] ?? 8;
    const soFar = draft.order.length === 0 ? "" : ` (${draft.order.map((ability, index) => `${text.campaign.ability[ability]} ${[15, 14, 13, 12, 10, 8][index] ?? 0}`).join(", ")})`;
    const left = abilities.filter((ability) => !draft.order.includes(ability));
    return {
      content: t.bScores({ value, so_far: soFar }),
      components: [
        select(libraryCustomId("bScore", token), t.bScoresPlaceholder, left.map((ability) => ({ label: text.campaign.ability[ability], value: ability }))),
        new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(button(libraryCustomId("bRecommended", token), t.bRecommended, ButtonStyle.Secondary)),
      ],
    };
  }

  private fullOrder(order: readonly Ability[]): readonly Ability[] {
    return order.length === abilities.length - 1 ? [...order, ...abilities.filter((ability) => !order.includes(ability))] : order;
  }

  private nameModal(token: string, text: Texts): ModalBuilder {
    const t = text.campaign.chars;
    const input = (id: string, label: string, style: TextInputStyle, required: boolean, max: number): ActionRowBuilder<TextInputBuilder> =>
      new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(max));
    return new ModalBuilder()
      .setCustomId(libraryCustomId("bName", token))
      .setTitle(t.bNameTitle)
      .addComponents(input(nameField, t.bNameLabel, TextInputStyle.Short, true, 40), input(appearanceField, t.bAppearanceLabel, TextInputStyle.Paragraph, false, 300), input(backstoryField, t.bBackstoryLabel, TextInputStyle.Paragraph, false, 300));
  }

  // The build a finished draft and the form's words make, or null when the draft is not finished.
  private buildFrom(draft: Draft, words: { readonly name: string; readonly appearance: string; readonly backstory: string }): BuildChoices | null {
    if (draft.class === null || draft.race === null || draft.kit === null || draft.order.length < abilities.length - 1 || (draft.race === "half-elf" && (draft.raceAbilities.length !== 2 || draft.raceSkills.length !== 2))) return null;
    const scores = scoresOf(draft.order);
    const built = { ...suggestedAbilities(draft.class) } as Record<Ability, number>;
    for (const ability of abilities) built[ability] = scores[ability] ?? 0;
    return { class: draft.class, race: draft.race, ...(draft.race === "half-elf" ? { raceAbilityChoices: draft.raceAbilities, raceSkillChoices: draft.raceSkills } : {}), kit: draft.kit, abilities: built, skills: draft.skills, expertise: draft.expertise, ...words };
  }

  // One line for a saved character: class, hit points and armor class, all derived.
  public sheetLine(snapshot: LibrarySnapshot, text: Texts): string {
    const derived = deriveSnapshotSheet(snapshot.build, snapshot.gear, snapshot.progression);
    const sheet: CharacterSheet = { ...derived, id: "c-preview", ownerUserId: snapshot.ownerUserId };
    const armorClass = armorClassFrom(heroTraits(sheet, this.deps.content), abilityModifier(sheet.abilityScores.dex), unarmoredModifier(heroTraits(sheet, this.deps.content), sheet.abilityScores));
    return text.campaign.chars.sheetLine({ class: classLabel(text, snapshot.build.class), hp: sheet.maxHp, ac: armorClass });
  }

  private problemLines(problems: readonly BuildProblem[], text: Texts): string {
    const words = text.campaign.chars.problem as Readonly<Record<string, string>>;
    return problems.map((problem) => `• ${words[problem.code] ?? problem.code}`).join("\n");
  }

  private async exportFile(interaction: ButtonInteraction, userId: string, snapshotId: string, text: Texts): Promise<void> {
    const file = await this.deps.library.export(userId, snapshotId);
    const snapshot = await this.deps.library.snapshot(userId, snapshotId);
    if (file === undefined || snapshot === undefined) {
      await interaction.editReply({ content: text.campaign.chars.gone, components: [] });
      return;
    }
    const safeName = snapshot.build.name.replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 40) || "character";
    await interaction.editReply({ content: text.campaign.chars.exported, files: [{ attachment: Buffer.from(file, "utf8"), name: `${safeName}.json` }], components: [] });
  }

  // A screen replaces the last one, picture included: no files means the old picture goes.
  private async show(interaction: ButtonInteraction | StringSelectMenuInteraction, screen: LibraryScreen): Promise<void> {
    // Whatever language this screen's control was shown in, the next one keeps.
    const language = parseLibraryId(interaction.customId)?.language ?? languageOf(interaction);
    await interaction.editReply({ content: screen.content, components: speak(screen, language).components, files: [...(screen.files ?? [])], attachments: [] });
  }
}

// The lines that name every conflict, in the reader's language.
export function conflictLines(conflicts: readonly ImportConflict[], text: Texts): readonly string[] {
  const t = text.campaign.chars;
  const problems = t.problem as Readonly<Record<string, string>>;
  return conflicts.map((conflict) => {
    switch (conflict.code) {
      case "rulesetMismatch":
        return t.conflict.rulesetMismatch({ actual: conflict.actual, expected: conflict.expected });
      case "invalidBuild":
        return t.conflict.invalidBuild({ problem: problems[conflict.problem.code] ?? conflict.problem.code });
      case "unknownContent":
        return t.conflict.unknownContent({ id: conflict.id });
      case "invalidProgression":
        return t.conflict.invalidProgression({ problem: (t.progress as Readonly<Record<string, string>>)[conflict.problem.code] ?? conflict.problem.code });
      case "wornNotCarried":
        return t.conflict.wornNotCarried({ id: conflict.id });
    }
  });
}

function button(customId: string, label: string, style: ButtonStyle, disabled = false): ButtonBuilder {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
}

function select(customId: string, placeholder: string, options: readonly { readonly label: string; readonly value: string }[], min = 1, max = 1): ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(
    new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(placeholder).setMinValues(min).setMaxValues(max).addOptions(options.map((option) => ({ label: option.label.slice(0, 100), value: option.value }))),
  );
}

// "acrobatics" reads "DEX" next to its name.
function skillAbility(skill: Skill): string {
  return skillAbilities[skill].toUpperCase();
}
