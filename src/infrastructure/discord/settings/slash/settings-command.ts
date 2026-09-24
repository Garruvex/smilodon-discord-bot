import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { ChatInputCommandMetadata } from "../../../../application/commands/command-metadata.js";
import { defaultLanguage } from "../../../../application/i18n/language.js";
import { texts } from "../../../../application/i18n/texts.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import { settingsAccessPolicy, type SettingsEngine } from "../engine/settings-engine.js";
import { commandNameFor } from "../registry/paths.js";
import type { SettingsGroup } from "../registry/types.js";
import { buildSettingsCommandMetadata } from "./settings-slash-metadata.js";

// The slash surface of the settings engine: /settings-<group>, one command
// per registered group. It only turns the interaction into a request and
// the engine's result into a reply — everything else happens in the engine,
// shared with the admin panel and guided setup.
export class SettingsCommand implements BotCommand {
  public readonly definition: ChatInputCommandMetadata;
  public readonly module = CommandModule.Common;
  public readonly access = settingsAccessPolicy;

  public constructor(
    private readonly group: SettingsGroup,
    private readonly engine: SettingsEngine,
    private readonly profiles: GuildConfigurationProvider,
  ) {
    this.definition = buildSettingsCommandMetadata(group);
  }

  public async execute(context: CommandContext): Promise<void> {
    const { interaction } = context;
    if (!interaction.guildId) return;
    await context.responses.defer();

    const section = interaction.options.getSubcommandGroup(false);
    const node = interaction.options.getSubcommand(true);
    const registered = this.engine.find([this.group.name, section, node].filter(Boolean).join("."));
    if (!registered) return;

    const language = this.profiles.find(interaction.guildId)?.language ?? defaultLanguage;
    const result = await this.engine.run(registered, {
      guildId: interaction.guildId,
      guild: interaction.guild,
      actorUserId: interaction.user.id,
      language,
      values: interaction.options,
    }, { kind: "slash", command: [commandNameFor(this.group), section, node].filter(Boolean).join(" ") });

    switch (result.kind) {
      case "report":
        await context.responses.edit(result.text);
        return;
      case "rejected":
        await context.responses.edit(result.message);
        return;
      case "empty":
        await context.responses.edit(texts[language].settings.error.nothingGiven);
        return;
      case "updated":
        await context.responses.edit(result.description);
        return;
      case "done":
        await context.responses.edit({ content: result.message, files: [...result.files] });
    }
  }
}
