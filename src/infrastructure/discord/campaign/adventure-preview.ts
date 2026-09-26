import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

import { adventurePreview, type AdventureReport } from "../../../application/campaign/adventures/adventure-validator.js";
import type { StoredAdventure } from "../../../application/campaign/adventures/stored-adventure.js";
import type { Texts } from "../../../application/i18n/texts.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";

export const adventureIdPrefix = "dndadv";

export function adventureCustomId(action: "approve" | "discard", key: string): string {
  const id = `${adventureIdPrefix}:${action}:${key}`;
  if (id.length > 100) throw new Error(`Custom ID "${id}" is longer than 100 characters.`);
  return id;
}

export function parseAdventureId(customId: string): { readonly action: "approve" | "discard"; readonly key: string } | null {
  const [prefix, action, ...rest] = customId.split(":");
  if (prefix !== adventureIdPrefix || (action !== "approve" && action !== "discard") || rest.length === 0) return null;
  return { action, key: rest.join(":") };
}

export interface ReviewScreen {
  readonly content: string;
  readonly components: ActionRowBuilder<ButtonBuilder>[];
}

const maxContent = 1_900;

// What the person who brought an adventure reads before approving it: a
// spoiler-free summary (never the DM's notes or an NPC's secret), what the
// checks found, and Approve or Discard when nothing stands in the way. Or,
// when something does, only what to fix.
export function renderReview(input: { report: AdventureReport; adventure: StoredAdventure | null; text: Texts; glossary: Glossary | undefined }): ReviewScreen {
  const t = input.text.campaign.adventure;
  const { report, adventure } = input;
  const lines: string[] = [];
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
  if (report.errors.length > 0) lines.push("", t.previewErrors, ...report.errors.map((error) => `• ${error}`));
  if (report.warnings.length > 0) lines.push("", t.previewWarnings, ...report.warnings.map((warning) => `• ${warning}`));
  if (report.document !== null) lines.push("", `-# ${t.previewNoSpoilers}`);

  const content = lines.join("\n");
  const buttons =
    adventure === null || !report.ok
      ? []
      : [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(adventureCustomId("approve", adventure.key)).setLabel(t.approveButton).setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(adventureCustomId("discard", adventure.key)).setLabel(t.discardButton).setStyle(ButtonStyle.Secondary),
          ),
        ];
  return { content: content.length <= maxContent ? content : `${content.slice(0, maxContent)}…`, components: buttons };
}
