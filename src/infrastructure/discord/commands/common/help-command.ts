import { EmbedBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext, type CommandDefinition } from "../../../../application/commands/command.js";
import type { CommandRegistry } from "../../../../application/commands/command-registry.js";
import type { AccessPolicyService } from "../../../../application/access/access-policy-service.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const moduleLabels: Record<CommandModule, string> = {
  [CommandModule.Bootstrap]: "Setup",
  [CommandModule.Common]: "General",
  [CommandModule.Diagnostics]: "Diagnostics",
  [CommandModule.Music]: "Music",
  [CommandModule.Birthdays]: "Birthdays",
  [CommandModule.Nsfw]: "NSFW",
};

export class HelpCommand implements BotCommand {
  public readonly definition = {
    name: "help",
    description: "Lists available commands, or shows details for one.",
    options: [
      { type: "string", name: "command", description: "A command name to view details for.", required: false },
    ],
  } satisfies CommandDefinition;

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;

  public constructor(
    private readonly commandRegistry: CommandRegistry,
    private readonly accessPolicyService: AccessPolicyService,
    private readonly profiles: GuildConfigurationProvider,
  ) {}

  public async execute(context: CommandContext): Promise<void> {
    const embedColor = (this.profiles.find(context.interaction.guildId ?? "")?.embedColor
      ?? "#3B82F6") as `#${string}`;

    const visibleCommands = this.commandRegistry.getAll().filter((command) =>
      this.accessPolicyService.evaluate(command.access, command.module, context.interaction).allowed,
    );

    const commandName = context.interaction.options.getString("command");
    if (commandName) {
      const command = visibleCommands.find((candidate) => candidate.definition.name === commandName);
      if (!command) {
        await context.responses.reply(`No command named \`${commandName}\` is available to you here.`);
        return;
      }

      const usageTokens = [
        ...(command.definition.options ?? []).map((option) =>
          option.required ? `<${option.name}>` : `[${option.name}]`),
        ...(command.definition.subcommands ?? []).map((subcommand) => `[${subcommand.name}]`),
        ...(command.definition.subcommandGroups ?? []).map((group) => `[${group.name}]`),
      ];
      const usage = [`/${command.definition.name}`, ...usageTokens].join(" ");

      const embed = new EmbedBuilder()
        .setColor(embedColor)
        .setTitle(`/${command.definition.name}`)
        .setDescription(command.definition.description)
        .addFields(
          { name: "Usage", value: `\`${usage}\``, inline: true },
          { name: "Category", value: moduleLabels[command.module], inline: true },
        );
      await context.responses.reply({ embeds: [embed] });
      return;
    }

    const commandsByModule = new Map<CommandModule, string[]>();
    for (const command of visibleCommands) {
      const names = commandsByModule.get(command.module) ?? [];
      names.push(`\`${command.definition.name}\``);
      commandsByModule.set(command.module, names);
    }

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle("Commands")
      .setDescription("Here's what's available to you in this server. Use `/help <command>` for details.");
    for (const [module, names] of commandsByModule) {
      embed.addFields({ name: moduleLabels[module], value: names.join(", ") });
    }

    await context.responses.reply({ embeds: [embed] });
  }
}
