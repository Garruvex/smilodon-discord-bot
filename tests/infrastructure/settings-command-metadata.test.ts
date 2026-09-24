import { describe, expect, it } from "vitest";

import { buildSlashCommandBuilder } from "../../src/infrastructure/discord/commands/command-metadata-builder.js";
import { buildDefinitionForGroup } from "../../src/infrastructure/discord/settings/legacy-settings-command.js";
import { settingDefinitions, settingGroups } from "../../src/infrastructure/discord/settings/definitions/index.js";

// Discord rejects any chat-input command/subcommand/group/option name or
// description over 100 characters — discord.js validates this locally (via
// @sapphire/shapeshift) as soon as .setDescription()/.setName() is called,
// which means a too-long string here throws at bot STARTUP (command
// registration), not just on deploy. /settings-<group> is built dynamically
// from one small file per setting (./settings/*.ts), which makes it easy to
// write a description that reads fine in the source but is too long —
// exactly what happened with history-reactions-setting.ts. This test
// exercises the real discord.js builder so that failure shows up here
// instead of in production.
const discordNameDescriptionLimit = 100;

// Discord also caps a single command's TOTAL size — name + description
// summed across the command and every nested subcommand/option/choice — at
// 8000 characters (APPLICATION_COMMAND_TOO_LARGE if exceeded). Each setting
// group is now its OWN top-level command (see settings-command.ts's own
// doc comment for why — a single shared /settings command with every group
// nested under it silently crashed bot-yohta in production once already,
// when reaction-replies + history-reactions tipped total name+description
// length from ~7780 to ~8063). Splitting gives each group a fresh budget,
// so this threshold has a lot more headroom per command than the old
// shared one did — it's set well under the hard cap so a group that grows
// unusually large still fails a test with room to spare.
const totalSizeWarningThreshold = 4000;

function sumNameAndDescriptionLengths(node: unknown): number {
  if (!node || typeof node !== "object") return 0;
  const record = node as Record<string, unknown>;
  let total = 0;
  if (typeof record.name === "string") total += record.name.length;
  if (typeof record.description === "string") total += record.description.length;
  for (const choice of (record.choices as unknown[] | undefined) ?? []) {
    if (!choice || typeof choice !== "object") continue;
    const choiceRecord = choice as Record<string, unknown>;
    if (typeof choiceRecord.name === "string") total += choiceRecord.name.length;
    if (typeof choiceRecord.value === "string") total += choiceRecord.value.length;
  }
  for (const option of (record.options as unknown[] | undefined) ?? []) {
    total += sumNameAndDescriptionLengths(option);
  }
  return total;
}

describe("/settings-<group> command metadata", () => {
  it("builds a real discord.js SlashCommandBuilder for every group without throwing", () => {
    for (const group of settingGroups) {
      expect(() => buildSlashCommandBuilder(buildDefinitionForGroup(group)).toJSON(), `group "${group.name}"`).not.toThrow();
    }
  });

  it("keeps each group's total name+description length comfortably under Discord's 8000-character cap", () => {
    for (const group of settingGroups) {
      const json = buildSlashCommandBuilder(buildDefinitionForGroup(group)).toJSON();
      expect(sumNameAndDescriptionLengths(json), `group "${group.name}"`).toBeLessThanOrEqual(totalSizeWarningThreshold);
    }
  });

  it("keeps every setting group's description within Discord's 100-character limit", () => {
    for (const group of settingGroups) {
      expect(group.description.length, `group "${group.name}"`).toBeLessThanOrEqual(discordNameDescriptionLimit);
    }
  });

  it("keeps every setting's own description, and its options' descriptions, within Discord's 100-character limit", () => {
    for (const setting of settingDefinitions) {
      expect(setting.description.length, `setting "${setting.name}"`).toBeLessThanOrEqual(discordNameDescriptionLimit);
      for (const option of setting.configureOptions?.() ?? []) {
        expect(
          option.description.length,
          `setting "${setting.name}", option "${option.name}"`,
        ).toBeLessThanOrEqual(discordNameDescriptionLimit);
      }
    }
  });
});
