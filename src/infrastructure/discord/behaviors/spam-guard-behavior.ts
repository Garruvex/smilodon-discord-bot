import type { Message } from "discord.js";

import { BehaviorEvent, BehaviorResult, type BotBehavior } from "../../../application/behaviors/behavior.js";
import type { LinkGuardService } from "../security/link-guard-service.js";
import type { SpamService } from "../security/spam-service.js";

// Runs after the trap channel and before chat and link fixing: a message that
// was spam, or carried a refused link, is gone, and nothing should answer it.
// The spam check also has to see every message, even ones the other behaviors
// would skip, because a spam burst is only visible across messages.
export class SpamGuardBehavior implements BotBehavior<BehaviorEvent.MessageCreated> {
  public readonly id = "spam-guard";
  public readonly event = BehaviorEvent.MessageCreated;
  public readonly priority = 150;

  public constructor(
    private readonly spam: SpamService,
    private readonly links: LinkGuardService,
  ) {}

  public matches(message: Message): Promise<boolean> {
    if (!message.inGuild() || message.author.bot) return Promise.resolve(false);
    return Promise.resolve(this.spam.enabledFor(message.guildId) || this.links.enabledFor(message.guildId));
  }

  public async execute(message: Message): Promise<BehaviorResult> {
    if (!message.inGuild()) return BehaviorResult.Continue;
    if (await this.links.handle(message)) return BehaviorResult.StopPropagation;
    if (await this.spam.handle(message)) return BehaviorResult.StopPropagation;
    return BehaviorResult.Continue;
  }
}
