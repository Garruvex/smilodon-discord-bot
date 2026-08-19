import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { BirthdayStore } from "../../../../application/birthdays/birthday-store.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export class BirthdayCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("birthday")
    .setDescription("Manages birthdays for this server's announcements.")
    .addSubcommand((command) => command.setName("set").setDescription("Sets your birthday.")
      .addIntegerOption((option) => option.setName("month").setDescription("Birth month.").setMinValue(1).setMaxValue(12).setRequired(true))
      .addIntegerOption((option) => option.setName("day").setDescription("Birth day.").setMinValue(1).setMaxValue(31).setRequired(true)))
    .addSubcommand((command) => command.setName("view").setDescription("Shows a member's birthday.")
      .addUserOption((option) => option.setName("user").setDescription("The member to look up; defaults to you.").setRequired(false)))
    .addSubcommand((command) => command.setName("remove").setDescription("Removes your birthday."));

  public readonly module = CommandModule.Birthdays;
  public readonly access = publicAccessPolicy;

  public constructor(private readonly birthdayStore: BirthdayStore) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.guildId) {
      await context.responses.reply("This only works in a server.");
      return;
    }
    const guildId = context.interaction.guildId;
    const subcommand = context.interaction.options.getSubcommand(true);

    if (subcommand === "set") {
      const month = context.interaction.options.getInteger("month", true);
      const day = context.interaction.options.getInteger("day", true);
      if (day > daysInMonth[month - 1]!) {
        await context.responses.reply(`${monthNames[month - 1]} only has ${daysInMonth[month - 1]} days.`);
        return;
      }
      await this.birthdayStore.setBirthday(guildId, context.interaction.user.id, month, day);
      await context.responses.reply(`Your birthday is set to ${monthNames[month - 1]} ${day}.`);
      return;
    }

    if (subcommand === "remove") {
      const removed = await this.birthdayStore.removeBirthday(guildId, context.interaction.user.id);
      await context.responses.reply(removed ? "Your birthday has been removed." : "You don't have a birthday set.");
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
