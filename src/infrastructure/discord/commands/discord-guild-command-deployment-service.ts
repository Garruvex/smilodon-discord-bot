import { REST, Routes, type RESTPostAPIApplicationCommandsJSONBody } from "discord.js";

import { CommandModule } from "../../../application/commands/command.js";
import type { GuildCommandDeploymentService } from "../../../application/commands/guild-command-deployment-service.js";
import type { AnyCommandInteraction, BotCommand } from "../../../application/commands/command.js";
import type { CommandRegistry } from "../../../application/commands/command-registry.js";
import type { ApplicationConfiguration } from "../../../config/configuration.js";
import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import { buildMessageContextMenuCommandBuilder, buildSlashCommandBuilder } from "./command-metadata-builder.js";

export class DiscordGuildCommandDeploymentService
  implements GuildCommandDeploymentService
{
  private readonly rest: REST;

  public constructor(
    private readonly configuration: ApplicationConfiguration,
    private readonly commandRegistry: CommandRegistry,
  ) {
    this.rest = new REST({ version: "10" }).setToken(configuration.discord.token);
  }

  // Every non-Bootstrap command is always deployed, regardless of which
  // features a guild has enabled — feature-gating is enforced at runtime by
  // AccessPolicyService (see featureEnabledRule), so a `/settings` toggle
  // takes effect immediately without needing a redeploy.
  public async deploy(profile: GuildConfiguration): Promise<number> {
    const commandData = this.commandJson(
      this.commandRegistry.getAll().filter((command) => command.module !== CommandModule.Bootstrap),
    );

    await this.rest.put(
      Routes.applicationGuildCommands(
        this.configuration.discord.applicationId,
        profile.guildId,
      ),
      { body: commandData },
    );

    return commandData.length;
  }

  // Bootstrap commands (e.g. /setup) are the only ones deployed globally,
  // since they need to work in a guild that has no profile yet.
  public async deployBootstrap(): Promise<number> {
    const commandData = this.commandJson(
      this.commandRegistry.getAll().filter((command) => command.module === CommandModule.Bootstrap),
    );

    await this.rest.put(
      Routes.applicationCommands(this.configuration.discord.applicationId),
      { body: commandData },
    );

    return commandData.length;
  }

  private commandJson(
    commands: readonly BotCommand<AnyCommandInteraction>[],
  ): RESTPostAPIApplicationCommandsJSONBody[] {
    return commands.map((command) =>
      command.definition.type === "messageContextMenu"
        ? buildMessageContextMenuCommandBuilder(command.definition).toJSON()
        : buildSlashCommandBuilder(command.definition).toJSON(),
    );
  }
}
