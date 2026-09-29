import { ActionRowBuilder, StringSelectMenuBuilder } from "discord.js";

import type { Texts } from "../../../application/i18n/texts.js";
import { classTemplates } from "../../../domain/campaign/character/character-build.js";
import type { CharacterSheet } from "../../../domain/campaign/character/character-sheet.js";
import { classChoicesFor, levelUp, maxLevel, nextClassFor, xpForNextLevel, xpThresholds } from "../../../domain/campaign/character/leveling.js";
import { abilities } from "../../../domain/campaign/rules/effects.js";
import type { Glossary } from "../../../domain/campaign/rules/content-registry.js";
import { campaignCustomId } from "./campaign-ids.js";
import { classLabel, skillKey } from "./text-keys.js";
import { fightingStyles, heldFightingStyle } from "../../../domain/campaign/character/fighting-styles.js";

export interface LevelForm {
  readonly content: string;
  readonly components: ActionRowBuilder<StringSelectMenuBuilder>[];
}

const barWidth = 10;

function xpBar(sheet: CharacterSheet, next: number): string {
  const floor = xpThresholds[sheet.level - 1] ?? 0;
  const filled = Math.max(0, Math.min(barWidth, Math.floor((((sheet.xp ?? 0) - floor) / Math.max(1, next - floor)) * barWidth)));
  return "▰".repeat(filled) + "▱".repeat(barWidth - filled);
}

// The private level-up form: where the hero stands, what the next level gives,
// and the choices it owes, each a menu that saves as it is picked (the class
// the next level lands in, the skill a new class grants, and any Ability Score
// Improvement). One screen, redrawn after every choice, so nothing is a
// command to remember. The numbers come from levelUp itself, never restated.
export function renderLevelForm(input: { readonly campaignId: string; readonly sheet: CharacterSheet; readonly milestone: boolean; readonly text: Texts; readonly glossary: Glossary; readonly note?: string }): LevelForm {
  const { campaignId, sheet, text, glossary } = input;
  const t = text.campaign;
  const pendingAsi = sheet.pendingAsi ?? 0;
  const lines: string[] = [];
  if (input.note !== undefined) lines.push(input.note, "");
  lines.push(`**${t.sheet.title({ name: sheet.name, class: classLabel(text, sheet.className ?? null), level: sheet.level })}**`);

  const xpNext = xpForNextLevel(sheet.level);
  if (input.milestone) lines.push(t.level.milestone);
  else if (xpNext === null) lines.push(t.level.xpMax({ xp: sheet.xp ?? 0 }));
  else lines.push(t.level.xp({ bar: xpBar(sheet, xpNext), xp: sheet.xp ?? 0, next: xpNext }));

  const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  const landing = sheet.level >= maxLevel ? null : nextClassFor(sheet);
  if (sheet.level >= maxLevel) lines.push(t.level.maxed);
  else if (landing !== null) {
    const preview = levelUp(sheet, landing, sheet.pendingClassLevel?.buildClass === landing ? sheet.pendingClassLevel.skillChoice : undefined);
    if (pendingAsi === 0) lines.push(t.level.notYet);
    lines.push(t.level.next({ level: preview.level, class: classLabel(text, landing), classLevel: preview.classLevels[landing] ?? 1, hp: preview.maxHp - sheet.maxHp }));
    const gained = preview.features.slice(sheet.features.length).map((id) => glossary.names[id] ?? id);
    if (gained.length > 0) lines.push(t.level.gains({ features: gained.join(", ") }));
    if ((preview.pendingAsi ?? 0) > pendingAsi) lines.push(t.level.asiNext);

    const held = sheet.classLevels ?? {};
    const choices = classChoicesFor(sheet).slice(0, 25);
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(campaignCustomId("levelClass", campaignId))
          .setPlaceholder(t.level.classPlaceholder)
          .addOptions(
            choices.map(({ buildClass, current }) => ({
              label: (current ? t.level.classCurrent({ class: classLabel(text, buildClass), level: held[buildClass] ?? sheet.level }) : t.level.classNew({ class: classLabel(text, buildClass) })).slice(0, 100),
              description: (current ? t.level.classKeep : t.level.classMulti).slice(0, 100),
              value: buildClass,
              default: buildClass === landing,
            })),
          ),
      ),
    );
    // A class new to the hero may grant one of a few skills: the pick is theirs.
    const offered = classTemplates[landing].multiclassSkillChoices ?? [];
    const isNew = (held[landing] ?? 0) === 0;
    if (isNew && offered.length > 0) {
      const chosen = sheet.pendingClassLevel?.skillChoice ?? offered[0];
      components.push(
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(campaignCustomId("levelSkill", campaignId, landing))
            .setPlaceholder(t.level.skillPlaceholder)
            .addOptions(offered.map((skill) => ({ label: t.skill[skillKey(skill)], value: skill, default: skill === chosen }))),
        ),
      );
    }
  }

  if (pendingAsi > 0) {
    lines.push(t.sheet.pendingAsi({ count: pendingAsi }), t.asi.prompt({ count: pendingAsi }));
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(campaignCustomId("asiPick", campaignId))
          .setPlaceholder(t.asi.placeholder)
          .setMinValues(1)
          .setMaxValues(2)
          .addOptions(abilities.map((ability) => ({ label: `${t.ability[ability]} ${sheet.abilityScores[ability]}`, value: ability }))),
      ),
    );
  }
  // A hero whose class gives a Fighting Style may swap it for another.
  const style = heldFightingStyle(sheet.features);
  if (style !== null) {
    lines.push(t.level.styleNow({ style: glossary.names[style] ?? style }));
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(campaignCustomId("stylePick", campaignId))
          .setPlaceholder(t.level.stylePlaceholder)
          .addOptions(fightingStyles.map((id) => ({ label: (glossary.names[id] ?? id).slice(0, 100), value: id, default: id === style }))),
      ),
    );
  }
  if (components.length > 0) lines.push("", t.level.hint);
  return { content: lines.join("\n"), components };
}
