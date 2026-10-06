import type { Message } from "discord.js";

import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import type { TrapService } from "../security/trap-service.js";

// Runs before every other message behavior: a message in the trap channel is
// never something the chatbot or link fixer should answer, so it ends here.
export class TrapChannelBehavior implements BotBehavior<BehaviorEvent.MessageCreated> {
  public readonly id = "trap-channel";
  public readonly event = BehaviorEvent.MessageCreated;
  public readonly priority = 200;

  public constructor(
    private readonly profiles: GuildConfigurationProvider,
    private readonly trap: TrapService,
  ) {}

  public matches(message: Message): Promise<boolean> {
    if (!message.inGuild()) return Promise.resolve(false);
    const trap = this.profiles.find(message.guildId)?.security.trap;
    return Promise.resolve(trap?.enabled === true && trap.channelId === message.channelId);
  }

  public async execute(message: Message): Promise<BehaviorResult> {
    if (!message.inGuild()) return BehaviorResult.Continue;
    return await this.trap.handle(message) ? BehaviorResult.StopPropagation : BehaviorResult.Continue;
  }
}
