import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { PollService } from "../../../../application/polls/poll-service.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

export class VoteCommand implements BotCommand {
  public readonly definition = {
    name: "vote",
    description: "Creates a Yes/No poll.",
    options: [
      { type: "string", name: "title", description: "Poll title.", maxLength: 200, required: true },
      { type: "string", name: "description", description: "What members are voting on.", maxLength: 2_000, required: true },
      { type: "integer", name: "duration", description: "Seconds before the poll closes; omit to keep it open.", minValue: 10, maxValue: 86_400 },
    ],
  } satisfies BotCommand["definition"];

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
