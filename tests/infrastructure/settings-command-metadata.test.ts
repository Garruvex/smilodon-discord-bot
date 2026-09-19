import { describe, expect, it } from "vitest";

import { buildSlashCommandBuilder } from "../../src/infrastructure/discord/commands/command-metadata-builder.js";
import { buildDefinition } from "../../src/infrastructure/discord/commands/setup/settings-command.js";
import { settingDefinitions, settingGroups } from "../../src/infrastructure/discord/commands/setup/settings/index.js";

// Discord rejects any chat-input command/subcommand/group/option name or
// description over 100 characters — discord.js validates this locally (via
// @sapphire/shapeshift) as soon as .setDescription()/.setName() is called,
// which means a too-long string here throws at bot STARTUP (command
// registration), not just on deploy. /settings is built dynamically from
// one small file per setting (./settings/*.ts), which makes it easy to
// write a description that reads fine in the source but is too long —
// exactly what happened with history-reactions-setting.ts. This test
// exercises the real discord.js builder so that failure shows up here
// instead of in production.
const discordNameDescriptionLimit = 100;

// Discord also caps a single command's TOTAL size — name + description
// summed across the command and every nested group/subcommand/option/
// choice — at 8000 characters (APPLICATION_COMMAND_TOO_LARGE if exceeded).
// /settings is one command carrying every setting group, so this is a
// shared, shrinking budget: it silently crashed bot-yohta in production
// once already (adding reaction-replies + history-reactions tipped total
// name+description length from ~7780 to ~8063). The threshold below is
// intentionally well under the hard 8000 cap, so a future setting that
// pushes this close fails a test with room to spare, instead of only
// failing once it's already over.
const totalSizeWarningThreshold = 7800;

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

describe("/settings command metadata", () => {
  it("builds a real discord.js SlashCommandBuilder without throwing", () => {
    expect(() => buildSlashCommandBuilder(buildDefinition()).toJSON()).not.toThrow();
  });

  it("keeps the whole command's total name+description length comfortably under Discord's 8000-character cap", () => {
    const json = buildSlashCommandBuilder(buildDefinition()).toJSON();
    expect(sumNameAndDescriptionLengths(json)).toBeLessThanOrEqual(totalSizeWarningThreshold);
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
