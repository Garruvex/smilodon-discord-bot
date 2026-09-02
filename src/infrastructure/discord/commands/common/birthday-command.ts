import { MessageFlags, type GuildMember } from "discord.js";

import {
  CommandModule,
  CommandResponseVisibility,
  type BotCommand,
  type CommandContext,
} from "../../../../application/commands/command.js";
import type { BirthdayStore } from "../../../../application/birthdays/birthday-store.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const daysInYear = daysInMonth.reduce((total, count) => total + count, 0);

function isBotAdministrator(member: GuildMember, botAdministratorRoleIds: ReadonlySet<string>): boolean {
  return member.roles.cache.some((role) => botAdministratorRoleIds.has(role.id));
}

// Ordinal day-of-year using the same (leap) days-in-month scheme for both the
// birthday and "today", so the two stay comparable even outside leap years.
function dayOfYear(month: number, day: number): number {
  return daysInMonth.slice(0, month - 1).reduce((total, count) => total + count, day);
}

function resolveGuildToday(timeZone: string): { month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, month: "numeric", day: "numeric" }).formatToParts(new Date());
  const lookup = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { month: Number(lookup.month), day: Number(lookup.day) };
}

export class BirthdayCommand implements BotCommand {
  public readonly definition = {
    name: "birthday",
    description: "Manages birthdays for this server's announcements.",
    subcommands: [
      {
        name: "set",
        description: "Sets your birthday.",
        options: [
          { type: "integer", name: "month", description: "Birth month.", minValue: 1, maxValue: 12, required: true },
          { type: "integer", name: "day", description: "Birth day.", minValue: 1, maxValue: 31, required: true },
          { type: "user", name: "user", description: "Set another member's birthday instead (bot administrators only).", required: false },
        ],
      },
      {
        name: "view",
        description: "Shows a member's birthday.",
        options: [
          { type: "user", name: "user", description: "The member to look up; defaults to you.", required: false },
        ],
      },
      {
        name: "remove",
        description: "Removes your birthday.",
        options: [
          { type: "user", name: "user", description: "Remove another member's birthday instead (bot administrators only).", required: false },
        ],
      },
      {
        name: "next",
        description: "Shows whose birthday is coming up next.",
        options: [
          { type: "boolean", name: "public", description: "Show this to everyone instead of just you.", required: false },
        ],
      },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Birthdays;
  public readonly access = publicAccessPolicy;
  // Public at the CommandResponses level so each reply below can choose its
  // own ephemeral flag per call — set/view/remove stay private by always
  // setting the flag explicitly; only `next` varies it with the `public` option.
  public readonly responseVisibility = CommandResponseVisibility.Public;

  public constructor(
    private readonly birthdayStore: BirthdayStore,
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
  ) {}

  private async replyPrivately(context: CommandContext, content: string): Promise<void> {
    await context.responses.reply({ content, flags: MessageFlags.Ephemeral });
  }

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) {
      await this.replyPrivately(context, "This only works in a server.");
      return;
    }
    const guildId = context.interaction.guildId;
    const subcommand = context.interaction.options.getSubcommand(true);

    if (subcommand === "set" || subcommand === "remove") {
      const targetUser = context.interaction.options.getUser("user");
      if (targetUser && targetUser.id !== context.interaction.user.id) {
        const botAdministratorRoleIds = this.guildConfigurationProvider.find(guildId)?.roles.botAdministrator ?? new Set();
        if (!isBotAdministrator(context.interaction.member, botAdministratorRoleIds)) {
          await this.replyPrivately(context, "Only bot administrators can set or remove another member's birthday.");
          return;
        }
      }
      const actingOnUserId = targetUser?.id ?? context.interaction.user.id;

      if (subcommand === "set") {
        const month = context.interaction.options.getInteger("month", true);
        const day = context.interaction.options.getInteger("day", true);
        if (day > daysInMonth[month - 1]!) {
          await this.replyPrivately(context, `${monthNames[month - 1]} only has ${daysInMonth[month - 1]} days.`);
          return;
        }
        await this.birthdayStore.setBirthday(guildId, actingOnUserId, month, day);
        await this.replyPrivately(
          context,
          targetUser
            ? `<@${actingOnUserId}>'s birthday is set to ${monthNames[month - 1]} ${day}.`
            : `Your birthday is set to ${monthNames[month - 1]} ${day}.`,
        );
        return;
      }

      const removed = await this.birthdayStore.removeBirthday(guildId, actingOnUserId);
      await this.replyPrivately(
        context,
        removed
          ? (targetUser ? `<@${actingOnUserId}>'s birthday has been removed.` : "Your birthday has been removed.")
          : (targetUser ? `<@${actingOnUserId}> doesn't have a birthday set.` : "You don't have a birthday set."),
      );
      return;
    }

    if (subcommand === "next") {
      const records = await this.birthdayStore.listAllForGuild(guildId);
      const isPublic = context.interaction.options.getBoolean("public") ?? false;
      if (records.length === 0) {
        await context.responses.reply({
          content: "No one has set a birthday yet. Use `/birthday set` to add one.",
          flags: isPublic ? undefined : MessageFlags.Ephemeral,
        });
        return;
      }

      const timezone = this.guildConfigurationProvider.find(guildId)?.timezone ?? "UTC";
      const today = resolveGuildToday(timezone);
      const todayOrdinal = dayOfYear(today.month, today.day);

      let closestDaysUntil = Infinity;
      let closest: { userId: string; month: number; day: number }[] = [];
      for (const record of records) {
        const daysUntil = (dayOfYear(record.month, record.day) - todayOrdinal + daysInYear) % daysInYear;
        if (daysUntil < closestDaysUntil) {
          closestDaysUntil = daysUntil;
          closest = [record];
        } else if (daysUntil === closestDaysUntil) {
          closest.push(record);
        }
      }

      const { month, day } = closest[0]!;
      const names = closest.map((record) => `<@${record.userId}>`).join(", ");
      const when =
        closestDaysUntil === 0 ? "today" : closestDaysUntil === 1 ? "tomorrow" : `in ${closestDaysUntil} days`;
      await context.responses.reply({
        content: `🎂 Next up: ${names} — ${monthNames[month - 1]} ${day} (${when}).`,
        flags: isPublic ? undefined : MessageFlags.Ephemeral,
      });
      return;
    }

    const targetUser = context.interaction.options.getUser("user") ?? context.interaction.user;
    const birthday = await this.birthdayStore.getBirthday(guildId, targetUser.id);
    if (!birthday) {
      await this.replyPrivately(
        context,
        targetUser.id === context.interaction.user.id
          ? "You don't have a birthday set. Use `/birthday set` to add one."
          : `<@${targetUser.id}> hasn't set a birthday.`,
      );
      return;
    }
    await this.replyPrivately(context, `🎂 <@${targetUser.id}>'s birthday is ${monthNames[birthday.month - 1]} ${birthday.day}.`);
  }
}
