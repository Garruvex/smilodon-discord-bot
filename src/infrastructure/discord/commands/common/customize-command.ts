import { SlashCommandBuilder } from "discord.js";

import { CommandModule, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import type { UserCustomizationStore } from "../../../../application/chat/user-customization-store.js";
import type { ChatProvider } from "../../../../application/chat/chat-provider.js";
import { userCustomizationLimits, validateUserCustomization } from "../../../../application/chat/user-customization-policy.js";

export class CustomizeCommand implements BotCommand {
  public readonly definition = new SlashCommandBuilder()
    .setName("customize")
    .setDescription("Customize how the chatbot interacts with you specifically. Its identity and rules stay the same.")
    .addSubcommand((command) =>
      command.setName("set").setDescription("Sets or replaces your customization from a Markdown file.")
        .addAttachmentOption((option) =>
          option.setName("file").setDescription("A .md file describing how you'd like the bot to interact with you.").setRequired(true),
        ),
    )
    .addSubcommand((command) =>
      command.setName("view").setDescription("Shows your current customization in this server."),
    )
    .addSubcommand((command) =>
      command.setName("clear").setDescription("Clears your customization in this server. Does not affect memory."),
    );

  public readonly module = CommandModule.Common;
  public readonly access = publicAccessPolicy;

  public constructor(
    private readonly store: UserCustomizationStore,
    private readonly chatProvider: ChatProvider | null,
  ) {}

  public async execute(context: CommandContext): Promise<void> {
    if (!context.interaction.guildId) {
      await context.responses.reply("This only works in a server.");
      return;
    }
    const guildId = context.interaction.guildId;
    const userId = context.interaction.user.id;
    const subcommand = context.interaction.options.getSubcommand(true);

    if (subcommand === "view") {
      await this.view(context, guildId, userId);
      return;
    }
    if (subcommand === "clear") {
      await this.clear(context, guildId, userId);
      return;
    }
    await this.set(context, guildId, userId);
  }

  private async view(context: CommandContext, guildId: string, userId: string): Promise<void> {
    const current = await this.store.load(guildId, userId);
    if (!current) {
      await context.responses.reply("You haven't set any customization in this server yet. Use `/customize set` with a `.md` file.");
      return;
    }
    await context.responses.reply(`Your current customization in this server:\n\`\`\`\n${current.slice(0, 1_900)}\n\`\`\``);
  }

  private async clear(context: CommandContext, guildId: string, userId: string): Promise<void> {
    await this.store.clear(guildId, userId);
    await context.responses.reply("Your customization has been cleared. This does not affect what the bot remembers about you (see `/memory`).");
  }

  private async set(context: CommandContext, guildId: string, userId: string): Promise<void> {
    await context.responses.defer();
    const attachment = context.interaction.options.getAttachment("file", true);
    // Discord may report Markdown attachments as application/octet-stream, so the
    // extension, bounded download size, and decoded non-empty text are the
    // dependable validation signals here (same approach as guild personality uploads).
    if (!attachment.name.toLowerCase().endsWith(".md")) {
      await context.responses.edit("Your customization must be uploaded as a Markdown (.md) file.");
      return;
    }
    if (attachment.size > userCustomizationLimits.maxChars * 4) {
      await context.responses.edit(`Your customization file is too large. Keep it under ${userCustomizationLimits.maxChars} characters.`);
      return;
    }
    const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (!response?.ok) {
      await context.responses.edit("I couldn't download that file from Discord. Please try again.");
      return;
    }
    const data = Buffer.from(await response.arrayBuffer());
    const validation = validateUserCustomization(data.toString("utf8"));
    if (!validation.ok) {
      await context.responses.edit(validation.reason);
      return;
    }

    // Deterministic length/emptiness checks above are just a cheap pre-filter.
    // The model pass is the actual gate: it rewrites the submission into
    // plain style-preference fields and strips anything that reads as an
    // attempt to redefine identity or override rules, rather than storing
    // the user's raw text verbatim.
    if (!this.chatProvider?.analyzeUserCustomization) {
      await context.responses.edit("Chat isn't configured on this bot, so customization can't be reviewed right now.");
      return;
    }
    let markdown: string;
    try {
      const analysis = await this.chatProvider.analyzeUserCustomization(validation.value);
      if (!analysis.ok) {
        await context.responses.edit(`That customization wasn't accepted: ${analysis.reason}`);
        return;
      }
      markdown = analysis.markdown;
    } catch {
      await context.responses.edit("I couldn't review that customization right now. Please try again in a moment.");
      return;
    }

    await this.store.save(guildId, userId, markdown);
    await context.responses.edit(
      `Your customization has been saved as:\n\`\`\`\n${markdown.slice(0, 1_500)}\n\`\`\`\n` +
        "It only affects how the bot talks to you — its identity, rules, and shared server knowledge stay the same.",
    );
  }
}
