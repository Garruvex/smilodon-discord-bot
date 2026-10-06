import type { BirthdayStore } from "../../birthdays/birthday-store.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import { guildCalendarDate, validateBirthday } from "../../birthdays/birthday-message.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";

interface BirthdaySetToolArgs {
  month: number;
  day: number;
  birthYear?: number | null;
  message?: string | null;
}

const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export class BirthdaySetTool implements ChatTool<BirthdaySetToolArgs> {
  public readonly name = "set_my_birthday";
  public readonly description =
    "Saves the current Discord user's birthday for this server's birthday announcements. " +
    "Use only when the current user clearly asks to set or update their own birthday and supplies an unambiguous month and day. " +
    "Do not use for another person's birthday, a guessed date, or a date mentioned only in conversation history. " +
    "Ask for clarification if the date is ambiguous. Optionally save a supplied birth year and custom announcement message. " +
    "Never infer a birth year from an age. Null means leave that optional detail unchanged. " +
    "Message placeholders: {member}, {birthday}, {age}, {ordinal}, {date}, {days}.";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: ["month", "day", "birthYear", "message"],
    properties: {
      month: { type: "integer", description: "Birth month, from 1 (January) to 12 (December)." },
      day: { type: "integer", description: "Day of the birth month." },
      birthYear: { type: ["integer", "null"], description: "Explicitly supplied birth year, or null to leave unchanged." },
      message: { type: ["string", "null"], description: "Custom announcement message, up to 1000 characters; null leaves unchanged." },
    },
  };

  public constructor(
    private readonly birthdayStore: BirthdayStore,
    private readonly guildConfigurationProvider: Pick<GuildConfigurationProvider, "find">,
  ) {}

  public async execute(args: BirthdaySetToolArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    const { month, day } = args;
    if (!Number.isInteger(month) || month < 1 || month > 12 ||
        !Number.isInteger(day) || day < 1 || day > daysInMonth[month - 1]!) {
      return { content: "Invalid birthday date. Ask the user for a valid month and day; nothing was saved." };
    }
    if (ctx.signal?.aborted) return { content: "Birthday update timed out; nothing was saved." };

    try {
      if (!this.guildConfigurationProvider.find(ctx.guildId)?.features.birthdays) {
        return { content: "Birthdays are not enabled in this server; nothing was saved." };
      }
      const details = {
        ...(args.birthYear != null ? { birthYear: args.birthYear } : {}),
        ...(args.message != null ? { message: args.message } : {}),
      };
      const profile = this.guildConfigurationProvider.find(ctx.guildId)!;
      const previous = await this.birthdayStore.getBirthday(ctx.guildId, ctx.currentUser.id);
      const error = validateBirthday(month, day, { ...previous, ...details }, guildCalendarDate(new Date(), profile.timezone).year);
      if (error) return { content: `${error} Nothing was saved.` };
      if (!this.guildConfigurationProvider.find(ctx.guildId)?.features.birthdays || ctx.signal?.aborted) {
        return { content: "Birthday update is no longer available; nothing was saved." };
      }
      await this.birthdayStore.setBirthday(ctx.guildId, ctx.currentUser.id, month, day, details);
      return { content: `Your birthday is set to ${monthNames[month - 1]} ${day} in this server.` };
    } catch {
      return { content: "Could not save the birthday. Ask the user to try again; nothing was confirmed." };
    }
  }
}
