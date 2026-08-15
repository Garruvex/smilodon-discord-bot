import { REST, Routes } from "discord.js";

import { CommandModule } from "../../../application/commands/command.js";
import type { GuildCommandDeploymentService } from "../../../application/commands/guild-command-deployment-service.js";
import type { CommandRegistry } from "../../../application/commands/command-registry.js";
import type { ApplicationConfiguration } from "../../../config/configuration.js";
import type { GuildConfiguration } from "../../../config/guild-configuration.js";

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

  public async deploy(profile: GuildConfiguration): Promise<number> {
    const commandData = this.commandRegistry.toApplicationCommandDataForModules(
      this.enabledModules(profile),
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

  public async deployBootstrap(): Promise<number> {
    const commandData = this.commandRegistry.toApplicationCommandDataForModules(
      new Set([CommandModule.Bootstrap]),
    );

    await this.rest.put(
      Routes.applicationCommands(this.configuration.discord.applicationId),
      { body: commandData },
    );

    return commandData.length;
  }

  private enabledModules(profile: GuildConfiguration): ReadonlySet<CommandModule> {
    const modules = new Set<CommandModule>();
    if (profile.features.common) modules.add(CommandModule.Common);
    if (profile.features.diagnostics) modules.add(CommandModule.Diagnostics);
    if (profile.features.music) modules.add(CommandModule.Music);
    return modules;
  }
}
