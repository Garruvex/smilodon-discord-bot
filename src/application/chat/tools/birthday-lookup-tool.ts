import type { BirthdayStore } from "../../birthdays/birthday-store.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { birthdayOccurrence, guildCalendarDate } from "../../birthdays/birthday-message.js";

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

  public constructor(
    private readonly birthdayStore: BirthdayStore,
    private readonly profiles: Pick<GuildConfigurationProvider, "find">,
  ) {}

  public async execute(args: BirthdayLookupToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    const record = await this.birthdayStore.getBirthday(ctx.guildId, args.userId);
    if (!record) return { content: "No birthday on file for that user." };
    const occurrence = birthdayOccurrence(record, guildCalendarDate(new Date(), this.profiles.find(ctx.guildId)?.timezone ?? "UTC"));
    return { content: JSON.stringify({ month: record.month, day: record.day, birthYear: record.birthYear ?? null, nextBirthdayDate: occurrence.date.toISOString().slice(0, 10), daysUntil: occurrence.days, turningAge: occurrence.age }) };
  }
}
