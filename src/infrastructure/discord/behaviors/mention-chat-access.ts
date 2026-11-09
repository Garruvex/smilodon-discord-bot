import type { GuildMember, Message } from "discord.js";
import type { Logger } from "pino";
import type { MentionChatAccessReason } from "../../../application/access/chat-access-service.js";
import type { Admission, ChatInteraction, ChatPolicy } from "../../../application/chat/chat-policy.js";
import { emitChatDiagnostic } from "../../../application/diagnostics/chat-diagnostics.js";
import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../../config/guild-configuration-provider.js";

export const memberLookupDeadlineMs = 2000;
type AccessReason = Exclude<MentionChatAccessReason, "allowed">;
// `reason` is the member-access part of the admission; it selects the
// user-facing denial. Other denials (for example opt-outs) stay silent.
interface Resolution { profile: GuildConfiguration | null; admission: Admission; reason: MentionChatAccessReason | "chat_disabled"; refreshed: boolean }
const disabled: Admission = { admitted: false, reason: "chat_disabled", reasons: ["chat_disabled"] };

const accessReasons: ReadonlySet<string> = new Set<AccessReason>(["member_unavailable", "restricted_role", "channel_denied", "missing_chat_role"]);
function accessReason(admission: Admission): AccessReason | null {
  return (admission.reasons.find((reason) => accessReasons.has(reason)) as AccessReason | undefined) ?? null;
}

// Explicit requests may refresh a stale cached member once before the common
// ChatPolicy decides. Every result comes from ChatPolicy.admit.
export class MentionChatAccess {
  // Retain in-flight requests after a caller times out so repeated messages do
  // not enqueue more REST work. Results are never cached as authorization.
  private readonly pending = new Map<string, Promise<GuildMember | null>>();
  public constructor(private readonly policy: ChatPolicy, private readonly profiles: GuildConfigurationProvider, private readonly logger: Logger) {}

  public async resolve(message: Message, interaction: ChatInteraction = "direct_mention"): Promise<Resolution> {
    const decide = (refreshed: boolean, member: GuildMember | null): Resolution => {
      const profile = message.guildId ? this.profiles.find(message.guildId) : null;
      if (!profile?.features.chatbot) return { profile, admission: disabled, reason: "chat_disabled", refreshed };
      const admission = this.policy.admit(profile, message.channelId, interaction, { userId: message.author.id, bot: false, member });
      return { profile, admission, reason: accessReason(admission) ?? "allowed", refreshed };
    };
    const cached = decide(false, message.member);
    if (cached.reason === "allowed" || cached.reason === "chat_disabled") return cached;
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
    const current = decide(true, member);
    if (current.reason !== "chat_disabled") emitChatDiagnostic(this.logger, { event: "chat.access.refreshed", cachedReason: cached.reason, currentReason: current.reason });
    return current;
  }
}
