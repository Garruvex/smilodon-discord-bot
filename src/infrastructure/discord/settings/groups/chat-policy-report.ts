import { PermissionFlagsBits } from "discord.js";
import { effectiveChatPolicy } from "../../../../application/chat/effective-chat-policy.js";
import { guardedContextLimits } from "../../../../application/chat/guarded-conversation-context.js";
import { report } from "../registry/builders.js";
import type { NodeContext } from "../registry/types.js";

export function renderChatPolicy(context: Pick<NodeContext, "profile" | "text">, channelId: string, readiness: Parameters<typeof effectiveChatPolicy>[2], view = "overview"): string {
  const { profile, text } = context; const policy = effectiveChatPolicy(profile, channelId, readiness);
  const t = (key: string, params?: Readonly<Record<string, string | number>>): string => text.message("participation.policy", key, params);
  const reasons = (items: readonly string[]): string => items.map((reason) => t(reason)).join(", ") || t("none");
  const { limits } = policy.participation;
  const overview = [t("common", { reasons: reasons(policy.commonReasons) }),
    ...policy.modes.map((mode) => `${t(mode.mode)}: ${t(mode.reasons.some((reason) => !reason.endsWith("_unknown")) ? "blocked" : mode.reasons.length ? "unverified" : mode.shadow ? "shadow" : "ready")}${mode.reasons.some((reason) => !policy.commonReasons.includes(reason)) ? ` (${reasons(mode.reasons.filter((reason) => !policy.commonReasons.includes(reason)))})` : ""}`),
    t("scope", { source: t(policy.observationInherited ? "inherited" : "explicit"), overrides: policy.participationOverrides.join(", ") || t("none"), context: t(policy.contextOverride ? "yes" : "no") }),
    t("ping", { ping: t(policy.participation.barePingMode) }), t("views")];
  const contextLines = [t("common", { reasons: reasons(policy.commonReasons) }),
    t("context", { reasons: reasons(policy.historyReasons.filter((reason) => !policy.commonReasons.includes(reason))), count: policy.context.maxMessages, budget: policy.context.budget }),
    t("bounds", { pages: guardedContextLimits.pages, pageSize: guardedContextLimits.pageSize, targeted: guardedContextLimits.targetedPages, depth: guardedContextLimits.replyDepth, seconds: guardedContextLimits.workMs / 1000 }),
    t("storage", { memory: policy.memoryMode, scan: t(policy.scan ? "yes" : "no"), daily: t(policy.daily ? "yes" : "no") }),
    t("access", { chat: policy.roleCounts.chat, admin: policy.roleCounts.administrator, restricted: policy.roleCounts.restricted })];
  const activity = [
    t("activity", { activity: policy.participation.activity, text: limits.textCooldownMs / 1000, reaction: limits.reactionCooldownMs / 1000, texts: limits.textPerWindow, reactions: limits.reactionsPerWindow, interval: limits.continuationIntervalMs! / 1000, exchange: limits.continuationPerExchange!, window: limits.continuationPerWindow! }),
    t("scope", { source: t(policy.observationInherited ? "inherited" : "explicit"), overrides: policy.participationOverrides.join(", ") || t("none"), context: t(policy.contextOverride ? "yes" : "no") })];
  return [t("heading", { channel: channelId }), ...(view === "context" ? contextLines : view === "activity" ? activity : overview), t("caveat")].join("\n");
}

export const chatPolicyReport = report("policy", async (context) => {
  const { request, values, text, profile, deps } = context;
  const channelId = values.getChannel("channel")?.id;
  if (!channelId) return text.message("participation.policy", "choose");
  try {
    if (!request.guild || request.guild.id !== profile.guildId) throw new Error("scope");
    const [channel, viewer, bot] = await Promise.all([request.guild.channels.fetch(channelId, { force: true }),
      request.guild.members.fetch({ user: request.actorUserId, force: true }), request.guild.members.fetchMe({ force: true })]);
    const permissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
    if (!channel?.isTextBased() || channel.guildId !== profile.guildId || !channel.permissionsFor(viewer)?.has(permissions)) throw new Error("access");
    return renderChatPolicy(context, channelId, { reply: deps.chatProviderAvailable ?? null,
      decision: deps.characterRuntime?.decisionAvailable ?? null, botRead: channel.permissionsFor(bot)?.has(permissions) ?? false }, values.getString("view") ?? "overview");
  } catch { return text.message("participation.policy", "denied"); }
}, { channel: { kind: "channel", textOnly: false }, view: { kind: "choice", choices: ["overview", "context", "activity"] } });
