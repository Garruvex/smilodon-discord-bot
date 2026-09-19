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

describe("/settings command metadata", () => {
  it("builds a real discord.js SlashCommandBuilder without throwing", () => {
    expect(() => buildSlashCommandBuilder(buildDefinition()).toJSON()).not.toThrow();
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
