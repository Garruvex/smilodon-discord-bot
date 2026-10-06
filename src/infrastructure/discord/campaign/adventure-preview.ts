import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

import { adventurePreview, type AdventureReport } from "../../../application/campaign/adventures/adventure-validator.js";
import { revisionOf, type StoredAdventure } from "../../../application/campaign/adventures/stored-adventure.js";
import type { Texts } from "../../../application/i18n/texts.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";

export const adventureIdPrefix = "dndadv";

// dndadv:<action>:<revision>:<key>. The revision names the text the review showed.
export type AdventureAction = "approve" | "discard" | "review" | "remove" | "confirmremove" | "keep" | "restore" | "example";
const actions: readonly string[] = ["approve", "discard", "review", "remove", "confirmremove", "keep", "restore", "example"];

export function adventureCustomId(action: AdventureAction, key: string, revision: string): string {
  const id = `${adventureIdPrefix}:${action}:${revision}:${key}`;
  if (id.length > 100) throw new Error(`Custom ID "${id}" is longer than 100 characters.`);
  return id;
}

export function parseAdventureId(customId: string): { readonly action: AdventureAction; readonly revision: string; readonly key: string } | null {
  const [prefix, action, revision, ...rest] = customId.split(":");
  if (prefix !== adventureIdPrefix || action === undefined || !actions.includes(action) || revision === undefined || !/^[0-9a-f]{8}$/.test(revision) || rest.length === 0) return null;
  return { action: action as AdventureAction, revision, key: rest.join(":") };
}

export interface ReviewScreen {
  readonly content: string;
  readonly components: ActionRowBuilder<ButtonBuilder>[];
  // The whole report, when it is too long for the message.
  readonly files?: { readonly attachment: Buffer; readonly name: string }[];
}

const maxContent = 1_900;

// What the person who brought an adventure reads before approving it: a
// spoiler-free summary (never the DM's notes or an NPC's secret), what the
// checks found, and Approve or Discard when nothing stands in the way. Or,
// when something does, only what to fix.
export function renderReview(input: { report: AdventureReport; adventure: StoredAdventure | null; replaced?: boolean; text: Texts; glossary: Glossary | undefined }): ReviewScreen {
  const t = input.text.campaign.adventure;
  const { report, adventure } = input;
  // What decides the outcome comes first, so a long preview can never push it off the screen.
  const lines: string[] = [
    ...(input.replaced === true ? [t.replacedNotice, ""] : []),
    ...(report.errors.length === 0 ? [] : [t.previewErrors, ...report.errors.map((error) => `• ${error}`), ""]),
    ...(report.warnings.length === 0 ? [] : [t.previewWarnings, ...report.warnings.map((warning) => `• ${warning}`), ""]),
  ];
  if (report.document !== null) {
    const preview = adventurePreview(report.document);
    const name = (id: string): string => input.glossary?.names[id] ?? id;
    lines.push(
      t.previewTitle({ title: preview.title, language: preview.language, source: adventure?.source === "author" ? t.sourceAuthor : t.sourceUpload }),
      preview.premise,
      "",
      t.previewScenes({ scenes: preview.scenes.join(" · ") }),
      ...(preview.npcs.length === 0 ? [] : [t.previewPeople({ people: preview.npcs.map((npc) => npc.name).join(" · ") })]),
      ...(preview.encounters.length === 0
        ? []
        : [t.previewFights, ...preview.encounters.map((fight) => t.previewFight({ scene: fight.scene, description: fight.description.replace(/\s+/g, " "), monsters: fight.monsters.map((monster) => `${monster.count}× ${name(monster.id)}`).join(", ") }))]),
      t.previewHeroes({ heroes: preview.heroes.map((hero) => hero.name).join(" · ") }),
    );
  }
  // What the conversion left out is the organizer's to see before approving.
  const omitted = report.document?.provenance?.omitted ?? [];
  if (omitted.length > 0) lines.push("", t.previewOmitted, ...omitted.slice(0, 10).map((entry) => `• ${t.previewOmittedItem({ item: entry.item, reason: entry.reason })}`), ...(omitted.length > 10 ? [`• … +${omitted.length - 10}`] : []));
  if (report.document !== null) lines.push("", `-# ${t.previewNoSpoilers}`);

  const content = lines.join("\n");
  const buttons =
    adventure === null || !report.ok
      ? []
      : [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(adventureCustomId("approve", adventure.key, revisionOf(adventure))).setLabel(t.approveButton).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(adventureCustomId("discard", adventure.key, revisionOf(adventure))).setLabel(t.discardButton).setStyle(ButtonStyle.Secondary),
          ),
        ];
  if (content.length <= maxContent) return { content, components: buttons };
  // Too long for a message: what decides the outcome is already at the top; the whole report comes as a file.
  return { content: `${content.slice(0, maxContent - 200)}…\n\n${t.previewTruncated}`, components: buttons, files: [{ attachment: Buffer.from(content, "utf8"), name: "review.txt" }] };
}

const shown = 20;

// The server's adventures with what can be done to each: review a draft, remove an approved one, restore a removed one.
export function renderLibrary(input: { adventures: readonly StoredAdventure[]; text: Texts }): ReviewScreen {
  const t = input.text.campaign.adventure;
  const example = new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(adventureCustomId("example", "example", "00000000")).setLabel(t.exampleButton).setStyle(ButtonStyle.Secondary));
  if (input.adventures.length === 0) return { content: t.libraryEmpty, components: [example] };
  const list = input.adventures.slice(0, shown);
  const status = { pending: t.statusPending, approved: t.statusApproved, removed: t.statusRemoved, discarded: t.discarded } as const;
  const lines = [
    `**${t.libraryTitle}**`,
    ...list.map((adventure) => t.libraryLine({ title: adventure.title, language: adventure.language, version: adventure.version, status: status[adventure.status], uploader: adventure.uploaderUserId })),
    ...(input.adventures.length > shown ? [t.libraryMore({ count: input.adventures.length - shown })] : []),
  ];
  const label = (text: string): string => (text.length <= 80 ? text : `${text.slice(0, 79)}…`);
  const buttons = list.map((adventure) => {
    const id = (action: AdventureAction): string => adventureCustomId(action, adventure.key, revisionOf(adventure));
    return adventure.status === "pending"
      ? new ButtonBuilder().setCustomId(id("review")).setLabel(label(t.reviewButton({ title: adventure.title }))).setStyle(ButtonStyle.Primary)
      : adventure.status === "approved"
        ? new ButtonBuilder().setCustomId(id("remove")).setLabel(label(t.removeButton({ title: adventure.title }))).setStyle(ButtonStyle.Danger)
        : new ButtonBuilder().setCustomId(id("restore")).setLabel(label(t.restoreButton({ title: adventure.title }))).setStyle(ButtonStyle.Secondary);
  });
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < buttons.length; index += 5) rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(index, index + 5)));
  return { content: lines.join("\n").slice(0, 1_900), components: [...rows, example] };
}

// Asks before removing: names the adventure and how many games still use this version.
export function renderRemoveAsk(input: { adventure: StoredAdventure; usage: { readonly lobbies: number; readonly running: number }; text: Texts }): ReviewScreen {
  const t = input.text.campaign.adventure;
  const { adventure } = input;
  const id = (action: AdventureAction): string => adventureCustomId(action, adventure.key, revisionOf(adventure));
  return {
    content: t.removeAsk({ title: adventure.title, language: adventure.language, version: adventure.version, lobbies: input.usage.lobbies, running: input.usage.running }),
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(id("confirmremove")).setLabel(t.removeConfirm).setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(id("keep")).setLabel(t.removeKeep).setStyle(ButtonStyle.Secondary))],
  };
}
