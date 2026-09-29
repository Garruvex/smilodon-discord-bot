import { ActionRowBuilder, ButtonBuilder, ButtonStyle, FileUploadBuilder, LabelBuilder, ModalBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from "discord.js";

import { maxNoteLength, portraitStyles, type PortraitRefusal, type PortraitStyle } from "../../../application/campaign/library/character-portraits.js";
import type { GeneratedImage } from "../../../application/campaign/ports/image-ports.js";
import type { Texts } from "../../../application/i18n/texts.js";
import { libraryCustomId } from "./library-ids.js";

// The portrait screens of My Characters: pure views, so the handler only
// decides what happens and these decide what it looks like. A portrait is one
// screen per state: home (what is there, what can be done), working, and a
// preview of a made picture with its three answers.

type Row = ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>;
export interface PortraitScreen {
  readonly content: string;
  readonly components: Row[];
  readonly files: { readonly attachment: Buffer; readonly name: string }[];
}

export const fileField = "file";
export const styleField = "style";
export const noteField = "note";

const extensions: Readonly<Record<GeneratedImage["mediaType"], string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const attach = (image: GeneratedImage | undefined): PortraitScreen["files"] => (image === undefined ? [] : [{ attachment: image.bytes, name: `portrait.${extensions[image.mediaType]}` }]);
const button = (customId: string, label: string, style: ButtonStyle, disabled = false): ButtonBuilder => new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style).setDisabled(disabled);
const styleLabel = (text: Texts, style: PortraitStyle): string => text.campaign.portrait.style[style];

// What is there and what can be done with it. `note` is a line about what just happened.
export function portraitHome(input: {
  readonly text: Texts;
  readonly characterId: string;
  readonly name: string;
  readonly current: GeneratedImage | undefined;
  readonly canUpload: boolean;
  readonly canPaint: boolean;
  readonly note?: string;
}): PortraitScreen {
  const t = input.text.campaign.portrait;
  const lines = [...(input.note === undefined ? [] : [input.note, ""]), t.title({ name: input.name }), t.intro, "", input.current === undefined ? t.none : t.has, ...(input.canUpload ? [] : ["", t.uploadOff])];
  const actions = [
    ...(input.canUpload ? [button(libraryCustomId("pUpload", input.characterId), t.uploadButton, ButtonStyle.Primary)] : []),
    ...(input.canPaint ? [button(libraryCustomId("pPaint", input.characterId), t.paintButton, input.canUpload ? ButtonStyle.Secondary : ButtonStyle.Primary)] : []),
  ];
  const more = [
    ...(input.current === undefined ? [] : [button(libraryCustomId("pRemove", input.characterId), t.removeButton, ButtonStyle.Danger)]),
    button(libraryCustomId("view", input.characterId), t.backButton, ButtonStyle.Secondary),
  ];
  return {
    content: lines.join("\n"),
    components: [...(actions.length === 0 ? [] : [new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(actions)]), new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(more)],
    files: attach(input.current),
  };
}

export function portraitWorking(text: Texts, name: string): PortraitScreen {
  return { content: text.campaign.portrait.working({ name }), components: [], files: [] };
}

// A made picture, with the three answers and a menu to try another look.
export function portraitPreview(input: { readonly text: Texts; readonly characterId: string; readonly name: string; readonly style: PortraitStyle; readonly image: GeneratedImage }): PortraitScreen {
  const t = input.text.campaign.portrait;
  const styles = new StringSelectMenuBuilder()
    .setCustomId(libraryCustomId("pStyle", input.characterId))
    .setPlaceholder(t.styleMenu)
    .addOptions(portraitStyles.map((style) => ({ label: styleLabel(input.text, style), value: style, default: style === input.style })));
  return {
    content: t.preview({ name: input.name, style: styleLabel(input.text, input.style) }),
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(styles),
      new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(
        button(libraryCustomId("pUse", input.characterId), t.useButton, ButtonStyle.Success),
        button(libraryCustomId("pRetry", input.characterId), t.retryButton, ButtonStyle.Secondary),
        button(libraryCustomId("pDrop", input.characterId), t.discardButton, ButtonStyle.Secondary),
      ),
    ],
    files: attach(input.image),
  };
}

// A refusal, in words, with the way back.
export function portraitRefused(text: Texts, characterId: string, reason: PortraitRefusal | "noFile" | "downloadFailed", retryAfterMinutes?: number): PortraitScreen {
  const words = text.campaign.portrait.refusal;
  const content = reason === "rateLimited" ? words.rateLimited({ minutes: retryAfterMinutes ?? 1 }) : words[reason];
  return {
    content,
    components: [new ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>().addComponents(button(libraryCustomId("pHome", characterId), text.campaign.portrait.backButton, ButtonStyle.Secondary))],
    files: [],
  };
}

// The upload form: one modal for the picture, the look and any extra words.
export function portraitModal(text: Texts, characterId: string): ModalBuilder {
  const t = text.campaign.portrait;
  return new ModalBuilder()
    .setCustomId(libraryCustomId("pSubmit", characterId))
    .setTitle(t.modalTitle)
    .addLabelComponents(
      new LabelBuilder().setLabel(t.fileLabel).setDescription(t.fileHint).setFileUploadComponent(new FileUploadBuilder().setCustomId(fileField).setRequired(true).setMinValues(1).setMaxValues(1)),
      new LabelBuilder()
        .setLabel(t.styleLabel)
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder().setCustomId(styleField).setRequired(true).addOptions(portraitStyles.map((style, index) => ({ label: styleLabel(text, style), value: style, default: index === 0 }))),
        ),
      new LabelBuilder()
        .setLabel(t.noteLabel)
        .setTextInputComponent(new TextInputBuilder().setCustomId(noteField).setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(maxNoteLength).setPlaceholder(t.notePlaceholder)),
    );
}
