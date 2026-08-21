import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import type { ChatStateStore } from "../../../../application/chat/chat-state-store.js";
import type { MemberProfileService } from "../../../../application/members/member-profile-service.js";
import type { MemoryEngine } from "../../../../application/memory/memory.js";

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
      const count = await this.memoryEngine.forget({ guildId, ownerUserId: userId });
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

    const forgotten = await this.memoryEngine.forget({ guildId, ownerUserId: userId, memoryId: match.id });
    await context.responses.reply(
      forgotten > 0 ? `Forgot: ${match.topic}.${match.slot}.` : "I couldn't find a memory with that ID.",
    );
  }
}
