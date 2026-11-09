import { PermissionFlagsBits, type GuildBasedChannel } from "discord.js";
import { CommandModule, CommandResponseVisibility, type BotCommand, type CommandContext } from "../../../../application/commands/command.js";
import { publicAccessPolicy } from "../../../../domain/access/access-policy.js";
import type { GuildConfigurationProvider } from "../../../../config/guild-configuration-provider.js";
import type { ChatTraceStore } from "../../../../application/diagnostics/chat-trace-store.js";
import { explainChatTrace } from "../../../../application/diagnostics/chat-explanation.js";
import { renderSafeChatExplanation } from "../../../../application/i18n/chat-explanation.js";
import { explainMessageText } from "../../../../application/i18n/explain-message.js";
import { messageInChannel } from "./message-reference.js";

export class ExplainMessageCommand implements BotCommand {
  public readonly definition = { name: "explain-message", description: "Explain your message, or a message you administer, in this channel.",
    options: [{ type: "string", name: "message", description: "Message ID or link from this channel.", required: true, maxLength: 150 }] } satisfies BotCommand["definition"];
  public readonly module = CommandModule.Diagnostics;
  public readonly access = { ...publicAccessPolicy, ownerBypass: false };
  public readonly responseVisibility = CommandResponseVisibility.Ephemeral;
  public constructor(private readonly traces: ChatTraceStore | null, private readonly profiles: GuildConfigurationProvider) {}
  public async execute(context: CommandContext): Promise<void> {
    const { guildId, channelId, guild, user } = context.interaction;
    const language = guildId ? this.profiles.find(guildId)?.language ?? "en" : "en";
    const text = explainMessageText[language];
    if (!guildId || !channelId || !guild) { await context.responses.reply(text.server); return; }
    const id = messageInChannel(context.interaction.options.getString("message", true).trim(), guildId, channelId);
    if (!id) { await context.responses.reply(text.invalid); return; }
    await context.responses.defer();
    try {
      const authorize = async (): Promise<{ channel: GuildBasedChannel; admin: boolean }> => {
        const [channel, member, bot] = await Promise.all([guild.channels.fetch(channelId, { force: true }),
          guild.members.fetch({ user: user.id, force: true }), guild.members.fetchMe({ force: true })]);
        const profile = this.profiles.find(guildId);
        const permissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
        if (!profile?.features.diagnostics || !channel || channel.guildId !== guildId || channel.id !== channelId ||
          !channel.permissionsFor(member)?.has(permissions) || !channel.permissionsFor(bot)?.has(permissions) ||
          [...profile.roles.restricted].some((role) => member.roles.cache.has(role))) throw new Error("unavailable");
        return { channel, admin: [...profile.roles.botAdministrator].some((role) => member.roles.cache.has(role)) };
      };
      const initial = await authorize();
      if (!initial.channel.isTextBased()) throw new Error("unavailable");
      const source = await initial.channel.messages.fetch({ message: id, force: true });
      if (source.guildId !== guildId || source.channelId !== channelId || source.id !== id) throw new Error("unavailable");
      const current = await authorize();
      if (source.author.id !== user.id && !current.admin) throw new Error("unavailable");
      if (!this.traces) { await context.responses.edit(text.unavailable); return; }
      const explanation = explainChatTrace(this.traces.lookup({ guildId, channelId, sourceMessageId: id }));
      await context.responses.edit([renderSafeChatExplanation(explanation, language), ...(current.admin ? [text.config] : [])].join("\n"));
    } catch { await context.responses.edit(text.denied); }
  }
}
