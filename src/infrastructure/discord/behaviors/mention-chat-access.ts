import type { GuildMember, Message } from "discord.js";
import type { Logger } from "pino";
import type { ChatAccessService, MentionChatAccessReason } from "../../../application/access/chat-access-service.js";
import { emitChatDiagnostic } from "../../../application/diagnostics/chat-diagnostics.js";
import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";

export const memberLookupDeadlineMs = 2000;
interface Resolution { profile: GuildConfiguration | null; reason: MentionChatAccessReason | "chat_disabled"; refreshed: boolean }

export class MentionChatAccess {
  // Retain in-flight requests after a caller times out so repeated messages do
  // not enqueue more REST work. Results are never cached as authorization.
  private readonly pending = new Map<string, Promise<GuildMember | null>>();
  public constructor(private readonly access: ChatAccessService, private readonly profiles: GuildConfigurationProvider, private readonly logger: Logger) {}

  public async resolve(message: Message): Promise<Resolution> {
    const profile = message.guildId ? this.profiles.find(message.guildId) : null;
    if (!profile?.features.chatbot) return { profile, reason: "chat_disabled", refreshed: false };
    const cachedReason = this.access.mentionChatAccessReason(profile, message.member, message.author.id, message.channelId);
    if (cachedReason === "allowed") return { profile, reason: cachedReason, refreshed: false };
    const key = `${message.guildId}:${message.author.id}`;
    let lookup = this.pending.get(key);
    if (!lookup && this.pending.size < 256 && message.guild) {
      lookup = message.guild.members.fetch({ user: message.author.id, force: true }).catch(() => null);
      this.pending.set(key, lookup);
      void lookup.then(() => this.pending.delete(key));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let member: GuildMember | null = null;
    try {
      if (lookup) member = await Promise.race([lookup, new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), memberLookupDeadlineMs); })]);
    } finally { if (timer) clearTimeout(timer); }
    const current = this.profiles.find(profile.guildId);
    if (!current?.features.chatbot) return { profile: current, reason: "chat_disabled", refreshed: true };
    const reason = this.access.mentionChatAccessReason(current, member, message.author.id, message.channelId);
    emitChatDiagnostic(this.logger, { event: "chat.access.refreshed", cachedReason, currentReason: reason });
    return { profile: current, reason, refreshed: true };
  }
}
