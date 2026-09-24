import { CommandModule, type BotCommand, type CommandContext } from "../../../application/commands/command.js";
import type { ChatInputCommandMetadata } from "../../../application/commands/command-metadata.js";
import type { SettingGroup, SettingRequest } from "./definitions/index.js";
import { settingsAccessPolicy } from "./engine/settings-engine.js";
import type { LegacySettingsEngine } from "./legacy-settings-engine.js";

// Exported for tests — buildSlashCommandBuilder(buildDefinitionForGroup(group))
// exercises the same discord.js validation deploy-time registration does.
export function buildDefinitionForGroup(group: SettingGroup): ChatInputCommandMetadata {
  return {
    name: `settings-${group.name}`,
    description: group.description,
    subcommands: group.settings.map((setting) => ({
      name: setting.name,
      description: setting.description,
      options: setting.configureOptions?.() ?? [],
    })),
  };
}

// /settings-<group> for the groups not yet in the settings registry (see
// ./definitions/index.ts). Deleted with LegacySettingsEngine.
export class LegacySettingsCommand implements BotCommand {
  public readonly definition: ChatInputCommandMetadata;

  public readonly module = CommandModule.Common;
  public readonly access = settingsAccessPolicy;

  public constructor(group: SettingGroup, private readonly engine: LegacySettingsEngine) {
    this.definition = buildDefinitionForGroup(group);
  }

  public async execute(context: CommandContext): Promise<void> {
    const { interaction } = context;
    if (!interaction.guildId) return;
    await context.responses.defer();
    const setting = this.engine.find(interaction.options.getSubcommand(true));
    if (!setting) return;

    const request: SettingRequest = {
      guildId: interaction.guildId,
      guild: interaction.guild ?? null,
      actorUserId: interaction.user.id,
      // Legacy settings write English confirmations.
      language: "en",
      values: interaction.options,
    };
    const result = await this.engine.run(setting, request, { kind: "slash", commandName: interaction.commandName });
    switch (result.kind) {
      case "report":
        await context.responses.edit(result.reply);
        return;
      case "rejected":
        await context.responses.edit(result.message);
        return;
      case "empty":
        await context.responses.edit("Provide at least one setting to change.");
        return;
      case "updated":
        await context.responses.edit(result.description);
    }
  }
}
