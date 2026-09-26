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
  type StringSelectMenuInteraction,
} from "discord.js";

import { maxCharactersPerOwner, type CharacterLibrary } from "../../../application/campaign/library/character-library.js";
import type { ImportConflict } from "../../../application/campaign/library/compatibility.js";
import type { LibrarySnapshot } from "../../../application/campaign/library/library-types.js";
import { CommandModule } from "../../../application/commands/command.js";
import type { ComponentContext, ComponentHandler, ModalContext } from "../../../application/components/component-handler.js";
import { texts, type Texts } from "../../../application/i18n/texts.js";
import { publicAccessPolicy } from "../../../domain/access/access-policy.js";
import { buildClasses, classTemplates, deriveSheet, suggestedAbilities, type BuildChoices, type BuildProblem } from "../../../domain/campaign/character/character-build.js";
import { abilityModifier, skillAbilities, type CharacterSheet, type Skill } from "../../../domain/campaign/character/character-sheet.js";
import { armorClassFrom, heroTraits } from "../../../domain/campaign/combat/combatant-profile.js";
import type { Glossary, SealedContent } from "../../../domain/campaign/rules/content-registry.js";
import { abilities, type Ability } from "../../../domain/campaign/rules/effects.js";
import { classLabel, skillKey } from "../campaign/text-keys.js";
import { decodeDraft, emptyDraft, encodeDraft, libraryCustomId, libraryIdPrefix, parseLibraryId, scoresOf, type Draft } from "../campaign/library-ids.js";

export interface CharacterLibraryHandlerDependencies {
  readonly library: CharacterLibrary;
  readonly content: SealedContent;
  readonly glossaries: Readonly<Record<string, Glossary>>;
}

type Row = ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>;
export interface LibraryScreen {
  readonly content: string;
  readonly components: Row[];
}

type Language = "en" | "zh-TW";
// The language of a person's own Discord client: the library belongs to the
// person, not to any one server or game.
export const languageOf = (interaction: { readonly locale: string }): Language => (interaction.locale.startsWith("zh") ? "zh-TW" : "en");

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
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(button(libraryCustomId("new"), t.newButton, ButtonStyle.Primary, entries.length >= maxCharactersPerOwner)));
    const lines = entries.map((entry) => t.line({ name: entry.character.name, class: classLabel(text, entry.character.className), count: entry.snapshots.length }));
    return { content: `**${t.title}**\n${t.intro}\n\n${lines.length === 0 ? t.empty : lines.join("\n")}`, components: rows };
  }

  public async execute(context: ComponentContext): Promise<void> {
    const { interaction } = context;
    const parsed = parseLibraryId(interaction.customId);
    if (parsed === null) return;
    const language = languageOf(interaction);
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
          return void (await this.show(interaction, this.kitScreen({ ...emptyDraft, class: buildClasses.find((id) => id === value) ?? null }, text)));
        case "bKit":
          return void (await this.show(interaction, this.skillsScreen({ ...decodeDraft(first), kit: value }, language)));
        case "bSkills": {
          const draft = decodeDraft(first);
          const chosen = { ...draft, skills: interaction.values.flatMap((skill) => (classTemplates[draft.class ?? "fighter"].skillChoices as readonly string[]).includes(skill) ? [skill as Draft["skills"][number]] : []), expertise: [] };
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
        default:
          return;
      }
    }
    if (!interaction.isButton()) return;
    switch (parsed.action) {
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
        return void (await interaction.showModal(this.nameModal(first ?? "", text)));
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
    if (parsed?.action !== "bName") return;
    const language = languageOf(interaction);
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
    await interaction.editReply({ content: text.campaign.chars.created({ name: made.character.name, sheet: this.sheetLine(made.snapshot, text) }) });
  }

  // ---- screens ------------------------------------------------------------

  private async viewScreen(userId: string, characterId: string, language: Language): Promise<LibraryScreen> {
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
    return {
      content: [t.viewTitle({ name: entry.character.name, class: classLabel(text, entry.character.className) }), t.viewScores({ scores }), "", ...lines].join("\n"),
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(
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
    const options = template.skillChoices.map((skill) => ({ label: `${text.campaign.skill[skillKey(skill)]} (${skillAbility(skill)})`, value: skill }));
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
    if (draft.class === null || draft.kit === null || draft.order.length < abilities.length - 1) return null;
    const scores = scoresOf(draft.order);
    const built = { ...suggestedAbilities(draft.class) } as Record<Ability, number>;
    for (const ability of abilities) built[ability] = scores[ability] ?? 0;
    return { class: draft.class, kit: draft.kit, abilities: built, skills: draft.skills, expertise: draft.expertise, ...words };
  }

  // One line for a saved character: class, hit points and armor class, all derived.
  public sheetLine(snapshot: LibrarySnapshot, text: Texts): string {
    const derived = deriveSheet(snapshot.build, snapshot.gear);
    const sheet: CharacterSheet = { ...derived, id: "c-preview", ownerUserId: snapshot.ownerUserId };
    const armorClass = armorClassFrom(heroTraits(sheet, this.deps.content), abilityModifier(sheet.abilityScores.dex));
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

  private async show(interaction: ButtonInteraction | StringSelectMenuInteraction, screen: LibraryScreen): Promise<void> {
    await interaction.editReply({ content: screen.content, components: screen.components });
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
