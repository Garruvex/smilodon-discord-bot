import { describe, expect, it } from "vitest";

import { buildSlashCommandBuilder } from "../../src/infrastructure/discord/commands/command-metadata-builder.js";
import { settingsRegistry } from "../../src/infrastructure/discord/settings/groups/index.js";
import { buildSettingsCommandMetadata } from "../../src/infrastructure/discord/settings/slash/settings-slash-metadata.js";

// discord.js validates names and descriptions (100 characters) as soon as
// a builder is given them, so a too-long one throws at bot startup, not
// just on deploy. The registry's own validation checks each piece of text;
// this builds the real commands so anything it misses fails here too.

// Discord caps a single command's TOTAL size — name + description
// summed across the command and every nested subcommand/option/choice — at
// 8000 characters (APPLICATION_COMMAND_TOO_LARGE if exceeded). Each setting
// group is its own top-level command (a single shared /settings command with every group
// nested under it silently crashed bot-yohta in production once already,
// when reaction-replies + history-reactions tipped total name+description
// length from ~7780 to ~8063). Splitting gives each group a fresh budget,
// so this threshold has a lot more headroom per command than the old
// shared one did — it's set well under the hard cap so a group that grows
// unusually large still fails a test with room to spare.
const totalSizeWarningThreshold = 4000;

// One locale's view of the command: a localized name or description where
// there is one, the base text otherwise.
function sumNameAndDescriptionLengths(node: unknown, locale: string | null = null): number {
  if (!node || typeof node !== "object") return 0;
  const record = node as Record<string, unknown>;
  const localized = (field: "name" | "description"): unknown =>
    (locale ? (record[`${field}_localizations`] as Record<string, string> | undefined)?.[locale] : undefined) ?? record[field];
  let total = 0;
  const name = localized("name");
  const description = localized("description");
  if (typeof name === "string") total += name.length;
  if (typeof description === "string") total += description.length;
  for (const choice of (record.choices as unknown[] | undefined) ?? []) {
    if (!choice || typeof choice !== "object") continue;
    const choiceRecord = choice as Record<string, unknown>;
    const choiceName = (locale ? (choiceRecord.name_localizations as Record<string, string> | undefined)?.[locale] : undefined)
      ?? choiceRecord.name;
    if (typeof choiceName === "string") total += choiceName.length;
    if (typeof choiceRecord.value === "string") total += choiceRecord.value.length;
  }
  for (const option of (record.options as unknown[] | undefined) ?? []) {
    total += sumNameAndDescriptionLengths(option, locale);
  }
  return total;
}

const built = settingsRegistry.map((group) => ({
  name: group.name,
  build: (): unknown => buildSlashCommandBuilder(buildSettingsCommandMetadata(group)).toJSON(),
}));

describe("/settings-<group> command metadata", () => {
  it("builds a real discord.js SlashCommandBuilder for every group without throwing", () => {
    for (const group of built) expect(group.build, `group "${group.name}"`).not.toThrow();
  });

  it("keeps each group's total name+description length comfortably under Discord's 8000-character cap, in every language", () => {
    for (const group of built) {
      const json = group.build();
      for (const locale of [null, "zh-TW", "ja"]) {
        expect(sumNameAndDescriptionLengths(json, locale), `group "${group.name}" (${locale ?? "en"})`)
          .toBeLessThanOrEqual(totalSizeWarningThreshold);
      }
    }
  });
});
