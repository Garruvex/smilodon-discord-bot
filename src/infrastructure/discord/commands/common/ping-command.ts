import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

export class PingCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Checks whether the bot is responding.");

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;

  public async execute(context: CommandContext): Promise<void> {
    const startedAt = Date.now();
    await context.responses.reply("Measuring latency…");

    const roundTripLatencyMs = Date.now() - startedAt;
    const gatewayLatencyMs = Math.round(context.interaction.client.ws.ping);
    await context.responses.edit(
      `Pong! Round trip: ${roundTripLatencyMs} ms · Gateway: ${gatewayLatencyMs} ms`,
    );
  }
}
