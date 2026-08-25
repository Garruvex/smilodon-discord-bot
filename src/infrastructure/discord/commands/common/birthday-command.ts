import type { GuildMember } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { BirthdayStore } from "../../../../application/birthdays/birthday-store.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isBotAdministrator(member: GuildMember, botAdministratorRoleIds: ReadonlySet<string>): boolean {
  return member.roles.cache.some((role) => botAdministratorRoleIds.has(role.id));
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
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Birthdays;
  public readonly access = publicAccessPolicy;

  public constructor(
    private readonly birthdayStore: BirthdayStore,
    private readonly guildConfigurationProvider: GuildConfigurationProvider,
  ) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) {
      await context.responses.reply("This only works in a server.");
      return;
    }
    const guildId = context.interaction.guildId;
    const subcommand = context.interaction.options.getSubcommand(true);

    if (subcommand === "set" || subcommand === "remove") {
      const targetUser = context.interaction.options.getUser("user");
      if (targetUser && targetUser.id !== context.interaction.user.id) {
        const botAdministratorRoleIds = this.guildConfigurationProvider.find(guildId)?.roles.botAdministrator ?? new Set();
        if (!isBotAdministrator(context.interaction.member, botAdministratorRoleIds)) {
          await context.responses.reply("Only bot administrators can set or remove another member's birthday.");
          return;
        }
      }
      const actingOnUserId = targetUser?.id ?? context.interaction.user.id;

      if (subcommand === "set") {
        const month = context.interaction.options.getInteger("month", true);
        const day = context.interaction.options.getInteger("day", true);
        if (day > daysInMonth[month - 1]!) {
          await context.responses.reply(`${monthNames[month - 1]} only has ${daysInMonth[month - 1]} days.`);
          return;
        }
        await this.birthdayStore.setBirthday(guildId, actingOnUserId, month, day);
        await context.responses.reply(
          targetUser
            ? `<@${actingOnUserId}>'s birthday is set to ${monthNames[month - 1]} ${day}.`
            : `Your birthday is set to ${monthNames[month - 1]} ${day}.`,
        );
        return;
      }

      const removed = await this.birthdayStore.removeBirthday(guildId, actingOnUserId);
      await context.responses.reply(
        removed
          ? (targetUser ? `<@${actingOnUserId}>'s birthday has been removed.` : "Your birthday has been removed.")
          : (targetUser ? `<@${actingOnUserId}> doesn't have a birthday set.` : "You don't have a birthday set."),
      );
      return;
    }

    const targetUser = context.interaction.options.getUser("user") ?? context.interaction.user;
    const birthday = await this.birthdayStore.getBirthday(guildId, targetUser.id);
    if (!birthday) {
      await context.responses.reply(
        targetUser.id === context.interaction.user.id
          ? "You don't have a birthday set. Use `/birthday set` to add one."
          : `<@${targetUser.id}> hasn't set a birthday.`,
      );
      return;
    }
    await context.responses.reply(`🎂 <@${targetUser.id}>'s birthday is ${monthNames[birthday.month - 1]} ${birthday.day}.`);
  }
}
