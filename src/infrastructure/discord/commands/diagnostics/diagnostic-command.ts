import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

export class DiagnosticCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("diagnostic")
    .setDescription("Displays owner-only runtime diagnostics.");

  public readonly module = CommandModule.Diagnostics;
  public readonly access = {
    ...publicAccessPolicy,
    ownerOnly: true,
  };

  public async execute(context: CommandContext): Promise<void> {
    const memoryUsageMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const uptimeSeconds = Math.round(process.uptime());

    await context.responses.reply({
      content: [
        `Uptime: ${uptimeSeconds} seconds`,
        `Resident memory: ${memoryUsageMb} MB`,
        `Guilds: ${context.interaction.client.guilds.cache.size}`,
      ].join("\n"),
    });
  }
}
