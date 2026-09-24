import { MessageFlags } from "discord.js";

import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { maxPollChoices, type PollService } from "../../../../application/polls/poll-service.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const optionNames = Array.from({ length: maxPollChoices }, (_, index) => `option${index + 1}`);

export class VoteCommand implements BotCommand {
  public readonly definition = {
    name: "vote",
    description: "Creates a poll: Yes/No by default, or up to five choices of your own.",
    options: [
      { type: "string", name: "title", description: "Poll title.", maxLength: 200, required: true },
      { type: "string", name: "description", description: "What members are voting on.", maxLength: 2_000 },
      { type: "integer", name: "duration", description: "Seconds before the poll closes; omit to keep it open.", minValue: 10, maxValue: 86_400 },
      ...optionNames.map((name, index) => ({
        type: "string" as const,
        name,
        description: `Choice ${index + 1}; give at least two choices, or none for Yes/No.`,
        maxLength: 100,
      })),
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;
  public readonly responseVisibility = CommandResponseVisibility.Public;

  public constructor(private readonly polls: PollService) {}

  public async execute(context: CommandContext): Promise<void> {
    const { interaction } = context;
    const options = optionNames
      .map((name) => interaction.options.getString(name)?.trim())
      .filter((option): option is string => !!option);
    const problem = options.length === 1
      ? context.text.poll.needTwoChoices
      : new Set(options.map((option) => option.toLowerCase())).size !== options.length
        ? context.text.poll.duplicateChoices
        : null;
    if (problem) {
      await interaction.reply({ content: problem, flags: MessageFlags.Ephemeral });
      return;
    }

    await this.polls.create(interaction, {
      title: interaction.options.getString("title", true),
      description: interaction.options.getString("description"),
      options: options.length > 0 ? options : null,
      durationSeconds: interaction.options.getInteger("duration"),
    });
  }
}
