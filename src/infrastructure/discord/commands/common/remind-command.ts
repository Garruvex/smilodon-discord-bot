import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import type { ReminderStore } from "../../../../application/reminders/reminder-store.js";
import { parseDurationMs } from "../../../../domain/time/duration.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";

const maxDurationMs = 90 * 24 * 60 * 60 * 1_000; // 90 days
const maxMessageLength = 500;

function discordTimestamp(ms: number): string {
  return `<t:${Math.floor(ms / 1_000)}:R>`;
}

export class RemindCommand implements BotCommand {
  public readonly definition = {
    name: "remind",
    description: "Manages your personal reminders.",
    subcommands: [
      {
        name: "set",
        description: "Sets a reminder.",
        options: [
          { type: "string", name: "duration", description: "e.g. 30m, 2h, 1d, or 1d12h.", required: true },
          { type: "string", name: "message", description: "What to remind you about.", required: true, maxLength: maxMessageLength },
        ],
      },
      { name: "list", description: "Lists your pending reminders." },
      {
        name: "cancel",
        description: "Cancels a reminder.",
        options: [
          { type: "string", name: "id", description: "The reminder id (from /remind list).", required: true },
        ],
      },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Reminders;
  public readonly access = publicAccessPolicy;

  public constructor(private readonly reminderStore: ReminderStore) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.inCachedGuild()) {
      await context.responses.reply("This only works in a server.");
      return;
    }
    const guildId = context.interaction.guildId;
    const userId = context.interaction.user.id;
    const subcommand = context.interaction.options.getSubcommand(true);

    if (subcommand === "set") {
      const durationInput = context.interaction.options.getString("duration", true);
      const message = context.interaction.options.getString("message", true);
      const durationMs = parseDurationMs(durationInput);

      if (durationMs === null || durationMs <= 0) {
        await context.responses.reply("Couldn't parse that duration. Try `30m`, `2h`, `1d`, or `1d12h`.");
        return;
      }
      if (durationMs > maxDurationMs) {
        await context.responses.reply("Reminders can be set at most 90 days out.");
        return;
      }

      const dueAt = Date.now() + durationMs;
      const reminder = await this.reminderStore.create({
        guildId, userId, channelId: context.interaction.channelId, message, dueAt,
      });
      await context.responses.reply(
        `Okay, I'll remind you ${discordTimestamp(reminder.dueAt)}: ${message}`,
      );
      return;
    }

    if (subcommand === "list") {
      const reminders = await this.reminderStore.listForUser(guildId, userId);
      if (reminders.length === 0) {
        await context.responses.reply("You have no pending reminders.");
        return;
      }
      const lines = reminders.map((r) =>
        `\`${r.id}\` — ${discordTimestamp(r.dueAt)}: ${r.message}`);
      await context.responses.reply(lines.join("\n"));
      return;
    }

    const id = context.interaction.options.getString("id", true);
    const cancelled = await this.reminderStore.cancel(id, userId);
    await context.responses.reply(cancelled ? "Reminder cancelled." : "Couldn't find a reminder with that id belonging to you.");
  }
}
