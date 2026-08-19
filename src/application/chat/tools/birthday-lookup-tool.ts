import type { BirthdayStore } from "../../birthdays/birthday-store.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";

interface BirthdayLookupToolArgs {
  userId: string;
}

export class BirthdayLookupTool implements ChatTool<BirthdayLookupToolArgs> {
  public readonly name = "lookup_birthday";
  public readonly description =
    "Looks up a Discord user's birthday on file, given their numeric user ID (from <current_user> or " +
    "<mentioned_users>). Returns whether one is on file at all.";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: ["userId"],
    properties: {
      userId: { type: "string", description: "Discord user ID to look up." },
    },
  };

  public constructor(private readonly birthdayStore: BirthdayStore) {}

  public async execute(args: BirthdayLookupToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    const record = await this.birthdayStore.getBirthday(ctx.guildId, args.userId);
    if (!record) return { content: "No birthday on file for that user." };
    return { content: JSON.stringify({ month: record.month, day: record.day }) };
  }
}
