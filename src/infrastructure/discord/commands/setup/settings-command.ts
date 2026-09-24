import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { ChatInputCommandMetadata } from "../../../../application/commands/command-metadata.js";
import type { ApplicationEmojiCatalog } from "../../application-emoji-catalog.js";
import { slashOptionsOf, type SettingGroup, type SettingRequest } from "../../settings/definitions/index.js";
import { renderProgressPreview } from "../../settings/definitions/settings-support.js";
import { settingsAccessPolicy, type SettingsEngine } from "../../settings/settings-engine.js";

// Exported for tests — buildSlashCommandBuilder(buildDefinitionForGroup(group))
// exercises the exact same discord.js validation (name/description length &
// pattern, and Discord's 8000-char total-size cap) that deploy-time
// registration does, without needing the whole command's dependency graph.
// Each settingGroups entry is now its own top-level command (see
// SettingsCommand's own doc comment for why) rather than one shared
// /settings command with every group nested under it — that used to mean
// every group's descriptions ate into the SAME 8000-char budget, which is
// exactly what crashed bot-yohta in production once already.
export function buildDefinitionForGroup(group: SettingGroup): ChatInputCommandMetadata {
  return {
    name: `settings-${group.name}`,
    description: group.description,
    subcommands: group.settings.map((setting) => ({
      name: setting.name,
      description: setting.description,
      options: slashOptionsOf(setting),
    })),
  };
}

// The slash surface of the settings engine: one instance per settingGroups
// entry (see bootstrap/dependencies.ts), each its own top-level
// /settings-<group> command. It only turns the interaction into a
// SettingRequest and the engine's result into a reply — running, validating,
// saving, auditing and describing a change all happen in SettingsEngine,
// shared with the admin panel. Subcommand dispatch is unaffected by which
// group a command belongs to: getSubcommand(true) returns just the leaf
// name, and setting names are unique across every group.
export class SettingsCommand implements BotCommand {
  public readonly definition: ChatInputCommandMetadata;

  public readonly module = CommandModule.Common;
  public readonly access = settingsAccessPolicy;

  public constructor(
    group: SettingGroup,
    private readonly engine: SettingsEngine,
    private readonly applicationEmojiCatalog: ApplicationEmojiCatalog,
  ) {
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
        await context.responses.edit(
          result.input.progressBar
            ? `${result.description}

Preview:
${renderProgressPreview(result.input.progressBar, this.applicationEmojiCatalog)}`
            : result.description,
        );
    }
  }
}
