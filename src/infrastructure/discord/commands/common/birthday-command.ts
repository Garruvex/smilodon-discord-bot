import { MessageFlags, type GuildMember } from "discord.js";

import {
  CommandModule,
  CommandResponseVisibility,
  type BotCommand,
  type CommandContext,
} from "../../../../application/commands/command.js";
import type { BirthdayRecord, BirthdayStore } from "../../../../application/birthdays/birthday-store.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import { formatBirthdayDate, birthdayOccurrence, guildCalendarDate, renderBirthdayMessage, validateBirthday } from "../../../../application/birthdays/birthday-message.js";
import { birthdayTexts } from "../../../../application/i18n/birthday-text.js";
import type { Language } from "../../../../application/i18n/language.js";


function isBotAdministrator(member: GuildMember, botAdministratorRoleIds: ReadonlySet<string>): boolean {
  return member.roles.cache.some((role) => botAdministratorRoleIds.has(role.id));
}


export function formatBirthdayListPages(records: readonly BirthdayRecord[], language: Language = "en"): string[] {
  const copy = birthdayTexts[language];
  const sorted = [...records].sort((a, b) => a.month - b.month || a.day - b.day || a.userId.localeCompare(b.userId));
  const pages: string[] = [];
  let page = copy.listTitle(sorted.length);
  for (const record of sorted) {
    const line = `\n${formatBirthdayDate(record.month, record.day, language)} — <@${record.userId}>`;
    if (page.length + line.length > 1_900) {
      pages.push(page);
      page = copy.listContinued;
    }
    page += line;
  }
  pages.push(page);
  return pages;
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
          { type: "integer", name: "year", description: "Optional birth year, used to show age.", minValue: 1900, required: false },
          { type: "string", name: "message", description: "Optional custom birthday announcement message (up to 1000 characters).", required: false },
          { type: "boolean", name: "clear-year", description: "Remove the saved birth year.", required: false },
          { type: "boolean", name: "clear-message", description: "Use the server message instead of a member message.", required: false },
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
        name: "list",
        description: "Shows all saved birthdays in this server.",
      },
      {
        name: "template",
        description: "Views or changes the server birthday message (bot administrators only).",
        options: [
          { type: "string", name: "message", description: "Template: {member}, {birthday}, {age}, {ordinal}, {date}, {days} (up to 1000 characters).", required: false },
          { type: "boolean", name: "reset", description: "Restore the default birthday announcement message.", required: false },
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
    if (context.interaction.deferred) await context.responses.edit({ content });
    else await context.responses.reply({ content, flags: MessageFlags.Ephemeral });
  }

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) {
      await this.replyPrivately(context, birthdayTexts.en.serverOnly);
      return;
    }
    const guildId = context.interaction.guildId;
    const language = this.guildConfigurationProvider.find(guildId)?.language ?? "en";
    const copy = birthdayTexts[language];
    const subcommand = context.interaction.options.getSubcommand(true);

    if (subcommand === "template") {
      const profile = this.guildConfigurationProvider.find(guildId);
      if (!isBotAdministrator(context.interaction.member, profile?.roles.botAdministrator ?? new Set())) {
        await this.replyPrivately(context, copy.adminTemplate);
        return;
      }
      const message = context.interaction.options.getString("message");
      const reset = context.interaction.options.getBoolean("reset") ?? false;
      if (message !== null && reset) {
        await this.replyPrivately(context, copy.templateConflict);
        return;
      }
      if (message !== null) {
        const error = validateBirthday(1, 1, { message }, new Date().getUTCFullYear(), language);
        if (error) return this.replyPrivately(context, error);
      }
      if (message !== null || reset) {
        await context.interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.guildConfigurationProvider.update(guildId, { birthdayMessageTemplate: reset ? null : message });
        await this.replyPrivately(context, reset ? copy.templateReset : copy.templateUpdated);
      } else {
        await this.replyPrivately(context, profile?.birthdayMessageTemplate ?? copy.templateDefault);
      }
      return;
    }

    if (subcommand === "list") {
      const records = await this.birthdayStore.listAllForGuild(guildId);
      if (records.length === 0) {
        await this.replyPrivately(context, copy.empty);
        return;
      }
      const [first, ...rest] = formatBirthdayListPages(records, language);
      await context.responses.reply({ content: first!, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      for (const content of rest) {
        await context.interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      }
      return;
    }

    if (subcommand === "set" || subcommand === "remove") {
      const targetUser = context.interaction.options.getUser("user");
      if (targetUser && targetUser.id !== context.interaction.user.id) {
        const botAdministratorRoleIds = this.guildConfigurationProvider.find(guildId)?.roles.botAdministrator ?? new Set();
        if (!isBotAdministrator(context.interaction.member, botAdministratorRoleIds)) {
          await this.replyPrivately(context, copy.adminMember);
          return;
        }
      }
      const actingOnUserId = targetUser?.id ?? context.interaction.user.id;

      if (subcommand === "set") {
        await context.interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (targetUser && targetUser.id !== context.interaction.user.id &&
            !await context.interaction.guild.members.fetch(targetUser.id).catch(() => null)) {
          await this.replyPrivately(context, copy.notMember);
          return;
        }
        const month = context.interaction.options.getInteger("month", true);
        const day = context.interaction.options.getInteger("day", true);
        const year = context.interaction.options.getInteger("year");
        const message = context.interaction.options.getString("message");
        const clearYear = context.interaction.options.getBoolean("clear-year") ?? false;
        const clearMessage = context.interaction.options.getBoolean("clear-message") ?? false;
        if ((year !== null && clearYear) || (message !== null && clearMessage)) {
          await this.replyPrivately(context, copy.detailsConflict);
          return;
        }
        const details = {
          ...(clearYear ? { birthYear: null } : year !== null ? { birthYear: year } : {}),
          ...(clearMessage ? { message: null } : message !== null ? { message } : {}),
        };
        const previous = await this.birthdayStore.getBirthday(guildId, actingOnUserId);
        const timezone = this.guildConfigurationProvider.find(guildId)?.timezone ?? "UTC";
        const error = validateBirthday(month, day, { ...previous, ...details }, guildCalendarDate(new Date(), timezone).year, language);
        if (error) return this.replyPrivately(context, error);
        await this.birthdayStore.setBirthday(guildId, actingOnUserId, month, day, details);
        await this.replyPrivately(
          context,
          targetUser
            ? copy.setMember(`<@${actingOnUserId}>`, formatBirthdayDate(month, day, language))
            : copy.setSelf(formatBirthdayDate(month, day, language)),
        );
        return;
      }

      const removed = await this.birthdayStore.removeBirthday(guildId, actingOnUserId);
      await this.replyPrivately(
        context,
        removed
          ? (targetUser ? copy.removedMember(`<@${actingOnUserId}>`) : copy.removedSelf)
          : (targetUser ? copy.missingMember(`<@${actingOnUserId}>`) : copy.missingSelf),
      );
      return;
    }

    if (subcommand === "next") {
      const records = await this.birthdayStore.listAllForGuild(guildId);
      const isPublic = context.interaction.options.getBoolean("public") ?? false;
      if (records.length === 0) {
        await context.responses.reply({
          content: copy.empty,
          flags: isPublic ? undefined : MessageFlags.Ephemeral,
        });
        return;
      }

      const timezone = this.guildConfigurationProvider.find(guildId)?.timezone ?? "UTC";
      const today = guildCalendarDate(new Date(), timezone);

      let closestDaysUntil = Infinity;
      let closest: BirthdayRecord[] = [];
      for (const record of records) {
        const daysUntil = birthdayOccurrence(record, today).days;
        if (daysUntil < closestDaysUntil) {
          closestDaysUntil = daysUntil;
          closest = [record];
        } else if (daysUntil === closestDaysUntil) {
          closest.push(record);
        }
      }

      let content = copy.nextTitle;
      for (const record of closest) {
        const line = renderBirthdayMessage(copy.countdownTemplate, record, birthdayOccurrence(record, today), language);
        if (content.length + line.length + 1 > 1_900) {
          if (!context.interaction.replied) await context.responses.reply({ content, flags: isPublic ? undefined : MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
          else await context.interaction.followUp({ content, flags: isPublic ? undefined : MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
          content = copy.nextContinued;
        }
        content += `${line}\n`;
      }
      if (!context.interaction.replied) await context.responses.reply({ content, flags: isPublic ? undefined : MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      else await context.interaction.followUp({ content, flags: isPublic ? undefined : MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }

    const targetUser = context.interaction.options.getUser("user") ?? context.interaction.user;
    const birthday = await this.birthdayStore.getBirthday(guildId, targetUser.id);
    if (!birthday) {
      await this.replyPrivately(
        context,
        targetUser.id === context.interaction.user.id
          ? copy.missingSelf
          : copy.missingMember(`<@${targetUser.id}>`),
      );
      return;
    }
    const today = guildCalendarDate(new Date(), this.guildConfigurationProvider.find(guildId)?.timezone ?? "UTC");
    await this.replyPrivately(context, renderBirthdayMessage(copy.countdownTemplate, birthday, birthdayOccurrence(birthday, today), language));
  }
}
