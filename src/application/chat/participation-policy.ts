import type { ChatActivityLimits } from "./chat-scheduler.js";

export interface ParticipationOverride {
  continuationEnabled?: boolean | undefined;
  spontaneousEnabled?: boolean | undefined;
  reactionsEnabled?: boolean | undefined;
  activity?: "quiet" | "balanced" | "lively" | undefined;
}
export interface ParticipationSettings {
  flowVersion?: "legacy" | "contextual_v1";
  continuationFailureMode?: "strict" | "grounded_fallback";
  messagesPerDecision?: number | undefined;
  spontaneousThreshold?: number | undefined;
  continuationThreshold?: number | undefined;
  observationChannelIds?: readonly string[] | undefined;
  continuationEnabled: boolean;
  spontaneousEnabled: boolean;
  spontaneousChannelIds: readonly string[];
  barePingMode: "acknowledge" | "personality";
  activity: "quiet" | "balanced" | "lively";
  shadowMode: boolean;
  channelOverrides: Readonly<Record<string, ParticipationOverride>>;
  advanced: {
    concurrency?: number | undefined;
    optionalTurnsPer10Minutes?: number | undefined;
    evaluationCooldownSeconds?: number | undefined;
    textCooldownSeconds?: number | undefined;
    reactionCooldownSeconds?: number | undefined;
    textPer10Minutes?: number | undefined;
    reactionsPer10Minutes?: number | undefined;
    continuationIntervalSeconds?: number | undefined;
    continuationPerExchange?: number | undefined;
    continuationPer10Minutes?: number | undefined;
  };
}

export const defaultParticipation: ParticipationSettings = {
  messagesPerDecision: 5, continuationEnabled: false, spontaneousEnabled: false, spontaneousChannelIds: [], barePingMode: "acknowledge",
  activity: "balanced", shadowMode: false, channelOverrides: {}, advanced: {},
};

const presets: Record<ParticipationSettings["activity"], ChatActivityLimits> = {
  quiet: { continuationIntervalMs: 30_000, continuationPerExchange: 6, continuationPerWindow: 15, evaluationCooldownMs: 30_000, textCooldownMs: 120_000, reactionCooldownMs: 40_000, textPerWindow: 1, reactionsPerWindow: 3 },
  balanced: { continuationIntervalMs: 15_000, continuationPerExchange: 10, continuationPerWindow: 30, evaluationCooldownMs: 25_000, textCooldownMs: 90_000, reactionCooldownMs: 30_000, textPerWindow: 3, reactionsPerWindow: 5 },
  lively: { continuationIntervalMs: 15_000, continuationPerExchange: 10, continuationPerWindow: 30, evaluationCooldownMs: 20_000, textCooldownMs: 60_000, reactionCooldownMs: 20_000, textPerWindow: 3, reactionsPerWindow: 5 },
};

export interface ResolvedParticipation extends ParticipationSettings {
  messagesPerDecision: number;
  reactionsEnabled?: boolean | undefined;
  limits: ChatActivityLimits;
}

export function resolveParticipation(settings: ParticipationSettings | undefined, channelId: string): ResolvedParticipation {
  const configured = settings ?? defaultParticipation;
  const override = configured.channelOverrides[channelId] ?? {};
  const base = presets[override.activity ?? configured.activity];
  const advanced = configured.advanced;
  return {
    ...configured, ...override,
    messagesPerDecision: configured.messagesPerDecision ?? 5,
    continuationEnabled: override.continuationEnabled ?? configured.continuationEnabled,
    activity: override.activity ?? configured.activity,
    // Explicit allow-list is required even when a channel override opts in.
    spontaneousEnabled: (override.spontaneousEnabled ?? configured.spontaneousEnabled) && configured.spontaneousChannelIds.includes(channelId),
    limits: {
      concurrency: advanced.concurrency ?? 4,
      optionalTurnsPerWindow: advanced.optionalTurnsPer10Minutes ?? 100,
      evaluationCooldownMs: advanced.evaluationCooldownSeconds === undefined ? base.evaluationCooldownMs : advanced.evaluationCooldownSeconds * 1_000,
      textCooldownMs: advanced.textCooldownSeconds === undefined ? base.textCooldownMs : advanced.textCooldownSeconds * 1_000,
      reactionCooldownMs: advanced.reactionCooldownSeconds === undefined ? base.reactionCooldownMs : advanced.reactionCooldownSeconds * 1_000,
      textPerWindow: advanced.textPer10Minutes ?? base.textPerWindow,
      reactionsPerWindow: advanced.reactionsPer10Minutes ?? base.reactionsPerWindow,
      continuationIntervalMs: (advanced.continuationIntervalSeconds ?? base.continuationIntervalMs! / 1000) * 1000,
      continuationPerExchange: advanced.continuationPerExchange ?? base.continuationPerExchange!,
      continuationPerWindow: advanced.continuationPer10Minutes ?? base.continuationPerWindow!,
    },
  };
}

export function isLowSubstancePing(message: string, hasTarget: boolean, hasImages: boolean): boolean {
  return !hasTarget && !hasImages && /^(?:\s*|hi|hey|yo|hello|嗨|嘿|哈囉|[?!？！]+)$/iu.test(message.trim());
}

export interface ContributionPolicy { spontaneousThreshold: number; continuationThreshold: number }
// Legacy thought threshold affected spontaneous admission only when thoughts
// were live. New explicit participation values take precedence, including zero.
export function contributionPolicy(settings: ParticipationSettings | undefined, legacy?: { enabled: boolean; shadow: boolean; threshold: number }): ContributionPolicy {
  return { spontaneousThreshold: settings?.spontaneousThreshold ?? Math.max(0.75, legacy?.enabled && !legacy.shadow ? legacy.threshold : 0),
    continuationThreshold: settings?.continuationThreshold ?? 0.5 };
}
export function passiveChannelAllowed(profile: { channels: { chatbot: ReadonlySet<string> }; chat: { participation?: ParticipationSettings } }, channelId: string): boolean {
  // Exact channel/thread selection; parent selection does not authorize threads.
  const channels = profile.chat.participation?.observationChannelIds;
  return channels ? channels.includes(channelId) : profile.channels.chatbot.has(channelId);
}
