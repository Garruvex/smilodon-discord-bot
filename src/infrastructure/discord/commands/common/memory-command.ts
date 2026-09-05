import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import type { ChatStateStore } from "../../../../application/chat/chat-state-store.js";
import type { MemberProfileService } from "../../../../application/members/member-profile-service.js";
import type { MemoryEngine } from "../../../../application/memory/memory.js";
import type { PersonalMemoryExtractionQueueStore } from "../../../../application/context/personal-memory-extraction-queue.js";

const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export class MemoryCommand implements BotCommand {
  public readonly definition = {
    name: "memory",
    description: "View or clear what the bot remembers about you from chat.",
    subcommands: [
      { name: "list", description: "Lists what the bot remembers about you in this server." },
      {
        name: "forget",
        description: "Deletes something the bot remembers about you.",
        options: [
          { type: "string", name: "id", description: "The memory ID to forget, from /memory list." },
          { type: "boolean", name: "all", description: "Forget everything the bot remembers about you in this server." },
        ],
      },
      {
        name: "notes",
        description: "Controls whether the bot DMs you extra notes about your chat requests.",
        options: [
          { type: "boolean", name: "dm", description: "Send notes like dropped images or truncated replies as a DM. Omit to check the current setting." },
        ],
      },
    ],
  } satisfies BotCommand["definition"];

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;

  public constructor(
    private readonly chatStateStore: ChatStateStore,
    private readonly memberProfileService: MemberProfileService,
    private readonly memoryEngine: MemoryEngine,
    // Optional: only wired when the personal-memory extraction queue exists
    // for this persistence backend (it always does — see
    // persistence-factory.ts — but keeping this optional avoids a hard
    // coupling for any future backend/test double that omits it).
    private readonly personalMemoryExtractionQueueStore?: PersonalMemoryExtractionQueueStore,
  ) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.guildId) {
      await context.responses.reply("This only works in a server.");
      return;
    }
    const guildId = context.interaction.guildId;
    const userId = context.interaction.user.id;
    const subcommand = context.interaction.options.getSubcommand(true);

    if (subcommand === "list") {
      await this.list(context, guildId, userId);
      return;
    }
    if (subcommand === "notes") {
      await this.notes(context, guildId, userId);
      return;
    }
    await this.forget(context, guildId, userId);
  }

  private async notes(context: CommandContext, guildId: string, userId: string): Promise<void> {
    const dm = context.interaction.options.getBoolean("dm");
    if (dm === null) {
      const enabled = await this.chatStateStore.getDmNotesEnabled(guildId, userId);
      await context.responses.reply(
        enabled
          ? "Notes (dropped images, truncated replies, etc.) are currently DMed to you. Use `/memory notes dm:false` to turn that off."
          : "Notes are currently off — you won't get DMs about dropped images, truncated replies, etc. Use `/memory notes dm:true` to turn that on.",
      );
      return;
    }
    await this.chatStateStore.setDmNotesEnabled(guildId, userId, dm);
    await context.responses.reply(
      dm ? "I'll DM you notes about your chat requests from now on." : "I won't DM you notes anymore.",
    );
  }

  private async list(context: CommandContext, guildId: string, userId: string): Promise<void> {
    const profile = await this.memberProfileService.load(guildId, userId);
    if (profile.memories.length === 0 && !profile.birthday && !profile.customization) {
      await context.responses.reply("I don't have anything remembered about you in this server yet.");
      return;
    }
    const profileLines: string[] = [];
    if (profile.birthday) {
      profileLines.push(
        `- [birthday] ${monthNames[profile.birthday.month - 1]} ${profile.birthday.day} — manage with \`/birthday\``,
      );
    }
    if (profile.customization) {
      profileLines.push("- [customization] set — manage with `/customize`");
    }
    const memoryLines = profile.memories.map((memory) =>
      `- \`${memory.id.slice(0, 8)}\` **${memory.topic}.${memory.slot}**: ${memory.statement}`,
    );
    const content = [
      `Here's what I remember about you in this server:`,
      ...profileLines,
      ...memoryLines,
      "",
      "Use `/memory forget id:<id>` to remove a memory, or `/memory forget all:true` to clear all memories.",
    ].join("\n").slice(0, 2_000);
    await context.responses.reply(content);
  }

  private async forget(context: CommandContext, guildId: string, userId: string): Promise<void> {
    const id = context.interaction.options.getString("id");
    const all = context.interaction.options.getBoolean("all");

    if (all === true) {
      // A still-queued (or already-succeeded-but-not-yet-cleaned-up, see
      // PersonalMemoryExtractionQueueStore.markSucceeded) extraction job
      // holds this user's own raw message text and can later (re)create a
      // private memory for them — "forget everything" must remove that
      // too, or it's not actually forgotten.
      // The shared subject boundary waits for an already-running worker (or
      // live chat write) before deleting its result, while a worker queued
      // afterward observes that its durable row is gone and exits.
      const forgetAll = async (): Promise<number> => {
        await this.personalMemoryExtractionQueueStore?.deleteForSubject(guildId, userId);
        return this.memoryEngine.forget({ guildId, ownerUserId: userId });
      };
      const count = this.personalMemoryExtractionQueueStore
        ? await this.personalMemoryExtractionQueueStore.runForSubject(guildId, userId, forgetAll)
        : await forgetAll();
      await context.responses.reply(
        count > 0 ? `Forgot ${count} ${count === 1 ? "memory" : "memories"}.` : "There was nothing to forget.",
      );
      return;
    }

    if (!id) {
      await context.responses.reply("Provide `id:<id>` (from `/memory list`) or `all:true`.");
      return;
    }

    const memories = await this.memoryEngine.listUserMemories(guildId, userId);
    const match = memories.find((memory) => memory.id === id || memory.id.startsWith(id));
    if (!match) {
      await context.responses.reply("I couldn't find a memory with that ID. Check `/memory list`.");
      return;
    }

    const forgetOne = async (): Promise<number> => {
      // Old queued source text could otherwise recreate the just-forgotten
      // slot. Cancel this subject's not-yet-processed historical jobs; new
      // messages after the command remain eligible for normal extraction.
      await this.personalMemoryExtractionQueueStore?.deleteForSubject(guildId, userId);
      return this.memoryEngine.forget({ guildId, ownerUserId: userId, memoryId: match.id });
    };
    const forgotten = this.personalMemoryExtractionQueueStore
      ? await this.personalMemoryExtractionQueueStore.runForSubject(guildId, userId, forgetOne)
      : await forgetOne();
    await context.responses.reply(
      forgotten > 0 ? `Forgot: ${match.topic}.${match.slot}.` : "I couldn't find a memory with that ID.",
    );
  }
}
