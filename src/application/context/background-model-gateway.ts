import type { PersonalMemoryExtractionAction, PersonalMemoryExtractor } from "../chat/chat-provider.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import type { ChannelMessageSummarizer, ChannelSummaryResult } from "./channel-message-summarizer.js";
import { type GuardedBackgroundContext, isBackgroundContext } from "./guarded-background-context.js";
import { approveModelOperation } from "./approved-model-operation.js";

// Owns serialization for the migrated background operations. It accepts no raw
// prompt/content override, and a summary handle cannot authorize extraction.
export class BackgroundModelGateway {
  public constructor(private readonly provider: ChannelMessageSummarizer & Partial<PersonalMemoryExtractor>) {}

  public async summarize(context: GuardedBackgroundContext): Promise<ChannelSummaryResult> {
    if (!isBackgroundContext(context, "summary")) throw new SocialOutputSuppressed();
    await context.check();
    const guildId = context.messages[0]!.guildId;
    const messages = context.messages.map(({ id, authorId, authorDisplayName, content }) => ({ id, authorId, authorDisplayName, content }));
    const result = await this.provider.summarizeChannelMessages(guildId, messages,
      approveModelOperation(context, "summarizeChannelMessages", [guildId, messages]));
    await context.check(); return result;
  }

  public async extract(context: GuardedBackgroundContext, subjectId: string): Promise<readonly PersonalMemoryExtractionAction[]> {
    if (!isBackgroundContext(context, "memory_extraction") || !this.provider.extractPersonalMemories || context.messages.some((message) => message.authorId !== subjectId)) throw new SocialOutputSuppressed();
    await context.check();
    const text = context.messages.map((message) => message.content).join("\n");
    const speaker = { id: subjectId, displayName: context.messages.at(-1)!.authorDisplayName };
    const result = await this.provider.extractPersonalMemories(text, "", speaker,
      approveModelOperation(context, "extractPersonalMemories", [text, "", speaker]));
    await context.check(); return result;
  }
}
