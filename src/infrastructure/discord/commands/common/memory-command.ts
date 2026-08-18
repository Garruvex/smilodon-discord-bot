import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import type { ChatStateStore } from "../../../../application/chat/chat-state-store.js";

export class MemoryCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("memory")
    .setDescription("View or clear what the bot remembers about you from chat.")
    .addSubcommand((command) =>
      command.setName("list").setDescription("Lists what the bot remembers about you in this server."),
    )
    .addSubcommand((command) =>
      command.setName("forget").setDescription("Deletes something the bot remembers about you.")
        .addStringOption((option) =>
          option.setName("id").setDescription("The memory ID to forget, from /memory list."),
        )
        .addBooleanOption((option) =>
          option.setName("all").setDescription("Forget everything the bot remembers about you in this server."),
        ),
    )
    .addSubcommand((command) =>
      command.setName("notes").setDescription("Controls whether the bot DMs you extra notes about your chat requests.")
        .addBooleanOption((option) =>
          option.setName("dm").setDescription("Send notes like dropped images or truncated replies as a DM. Omit to check the current setting."),
        ),
    );

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;

  public constructor(private readonly chatStateStore: ChatStateStore) {}

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
    const state = await this.chatStateStore.load(guildId, userId, Date.now());
    if (state.memories.length === 0) {
      await context.responses.reply("I don't have anything remembered about you in this server yet.");
      return;
    }
    const lines = state.memories.map((memory) =>
      `- \`${memory.id.slice(0, 8)}\` **${memory.topic}.${memory.slot}**: ${memory.statement}${memory.pinned ? " (pinned)" : ""}`,
    );
    const content = [
      `Here's what I remember about you in this server (${state.memories.length}):`,
      ...lines,
      "",
      "Use `/memory forget id:<id>` to remove one, or `/memory forget all:true` to clear everything.",
    ].join("\n").slice(0, 2_000);
    await context.responses.reply(content);
  }

  private async forget(context: CommandContext, guildId: string, userId: string): Promise<void> {
    const id = context.interaction.options.getString("id");
    const all = context.interaction.options.getBoolean("all");

    if (all === true) {
      const count = await this.chatStateStore.forgetAllMemories(guildId, userId);
      await context.responses.reply(
        count > 0 ? `Forgot ${count} ${count === 1 ? "memory" : "memories"}.` : "There was nothing to forget.",
      );
      return;
    }

    if (!id) {
      await context.responses.reply("Provide `id:<id>` (from `/memory list`) or `all:true`.");
      return;
    }

    const state = await this.chatStateStore.load(guildId, userId, Date.now());
    const match = state.memories.find((memory) => memory.id === id || memory.id.startsWith(id));
    if (!match) {
      await context.responses.reply("I couldn't find a memory with that ID. Check `/memory list`.");
      return;
    }

    const forgotten = await this.chatStateStore.forgetMemory(guildId, userId, match.id);
    await context.responses.reply(
      forgotten ? `Forgot: ${match.topic}.${match.slot}.` : "I couldn't find a memory with that ID.",
    );
  }
}
