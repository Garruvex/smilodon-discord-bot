import type { PollService } from "../../../application/polls/poll-service.js";
import type { ComponentContext, ComponentHandler } from "../../../application/components/component-handler.js";
import { publicAccessPolicy } from "../../../domain/access/access-policy.js";
import { CommandModule } from "../../../application/commands/command.js";

export class PollComponentHandler implements ComponentHandler {
  public readonly customIdPrefix = "poll";
  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;

  public constructor(private readonly polls: PollService) {}

  public async execute(context: ComponentContext): Promise<void> {
    if (!context.interaction.isButton()) return;
    await this.polls.handle(context.interaction);
  }
}
