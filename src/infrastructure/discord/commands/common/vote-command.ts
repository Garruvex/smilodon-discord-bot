import { SlashCommandBuilder } from "discord.js";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PollService } from "../../../../application/polls/poll-service.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

export class VoteCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("vote")
    .setDescription("Creates a Yes/No poll.")
    .addStringOption((option) => option.setName("title").setDescription("Poll title.").setMaxLength(200).setRequired(true))
    .addStringOption((option) => option.setName("description").setDescription("What members are voting on.").setMaxLength(2_000).setRequired(true))
    .addIntegerOption((option) => option.setName("duration").setDescription("Seconds before the poll closes; omit to keep it open.").setMinValue(10).setMaxValue(86_400));

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Public;

  public constructor(private readonly polls: PollService) {}

  public async execute(context: CommandContext): Promise<void> {
    await this.polls.create(
      context.interaction,
      context.interaction.options.getString("title", true),
      context.interaction.options.getString("description", true),
      context.interaction.options.getInteger("duration"),
    );
  }
}
