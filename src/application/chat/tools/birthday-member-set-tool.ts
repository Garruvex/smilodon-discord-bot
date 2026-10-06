import type { BirthdayStore } from "../../birthdays/birthday-store.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";
import type { ChatTool, ChatToolContext, ChatToolResult } from "./chat-tool.js";
import { guildCalendarDate, validateBirthday } from "../../birthdays/birthday-message.js";

interface BirthdayMemberSetArgs {
  userId: string;
  month: number;
  day: number;
  birthYear?: number | null;
  message?: string | null;
}

type ResolveMemberRoles = (guildId: string, userId: string) => Promise<readonly string[] | null>;
const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export class BirthdayMemberSetTool implements ChatTool<BirthdayMemberSetArgs> {
  public readonly name = "set_member_birthday";
  public readonly description =
    "Sets another server member's birthday, only for configured bot administrators. " +
    "Use only when the current user explicitly asks to set that member's birthday. " +
    "Use their supplied Discord user ID, never guess an ID or date. Ask for clarification for ambiguous dates. " +
    "Optionally save an explicitly supplied birth year and custom announcement message; never infer a year from an age. " +
    "Null leaves optional details unchanged. Message placeholders: {member}, {birthday}, {age}, {ordinal}, {date}, {days}.";
  public readonly parameters = {
    type: "object",
    additionalProperties: false,
    required: ["userId", "month", "day", "birthYear", "message"],
    properties: {
      userId: { type: "string", description: "The target server member's numeric Discord user ID." },
      month: { type: "integer", description: "Birth month, 1 through 12." },
      day: { type: "integer", description: "Day of the birth month." },
      birthYear: { type: ["integer", "null"], description: "Explicitly supplied birth year or null to leave unchanged." },
      message: { type: ["string", "null"], description: "Custom announcement message, up to 1000 characters; null leaves unchanged." },
    },
  };

  public constructor(
    private readonly birthdayStore: BirthdayStore,
    private readonly profiles: Pick<GuildConfigurationProvider, "find">,
    private readonly resolveMemberRoles: ResolveMemberRoles,
  ) {}

  public async execute(args: BirthdayMemberSetArgs, ctx: ChatToolContext): Promise<ChatToolResult> {
    const { userId, month, day } = args;
    if (typeof userId !== "string" || !/^\d{17,20}$/.test(userId) ||
        !Number.isInteger(month) || month < 1 || month > 12 ||
        !Number.isInteger(day) || day < 1 || day > daysInMonth[month - 1]!) {
      return { content: "Invalid member ID or birthday date; nothing was saved." };
    }
    try {
      const details = {
        ...(args.birthYear != null ? { birthYear: args.birthYear } : {}),
        ...(args.message != null ? { message: args.message } : {}),
      };
      if (!this.profiles.find(ctx.guildId)?.features.birthdays) {
        return { content: "Birthdays are not enabled in this server; nothing was saved." };
      }
      const actorRoles = await this.resolveMemberRoles(ctx.guildId, ctx.currentUser.id);
      const administratorRoles = this.profiles.find(ctx.guildId)?.roles.botAdministrator;
      if (!actorRoles?.some((roleId) => administratorRoles?.has(roleId))) {
        return { content: "Only bot administrators can set another member's birthday; nothing was saved." };
      }
      if (await this.resolveMemberRoles(ctx.guildId, userId) === null) {
        return { content: "That user is not a member of this server; nothing was saved." };
      }
      const previous = await this.birthdayStore.getBirthday(ctx.guildId, userId);
      const error = validateBirthday(month, day, { ...previous, ...details }, guildCalendarDate(new Date(), this.profiles.find(ctx.guildId)?.timezone ?? "UTC").year);
      if (error) return { content: `${error} Nothing was saved.` };
      if (!this.profiles.find(ctx.guildId)?.features.birthdays) {
        return { content: "Birthdays are not enabled in this server; nothing was saved." };
      }
      if (ctx.signal?.aborted) return { content: "Birthday update timed out; nothing was saved." };
      await this.birthdayStore.setBirthday(ctx.guildId, userId, month, day, details);
      return { content: JSON.stringify({ saved: true, userId, month, day }) };
    } catch {
      return { content: "Could not save the member's birthday. Ask the user to try again; nothing was confirmed." };
    }
  }
}
