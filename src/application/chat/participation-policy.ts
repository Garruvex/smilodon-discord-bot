import type { ChatActivityLimits } from "./chat-scheduler.js";

export interface ParticipationOverride {
  continuationEnabled?: boolean | undefined;
  spontaneousEnabled?: boolean | undefined;
  reactionsEnabled?: boolean | undefined;
  activity?: "quiet" | "balanced" | "lively" | undefined;
}
export interface ParticipationSettings {
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
    continuationPerExchange?: number | undefined;
    continuationPer10Minutes?: number | undefined;
  };
}

export const defaultParticipation: ParticipationSettings = {
  continuationEnabled: false, spontaneousEnabled: false, spontaneousChannelIds: [], barePingMode: "acknowledge",
  activity: "balanced", shadowMode: false, channelOverrides: {}, advanced: {},
};

const presets: Record<ParticipationSettings["activity"], ChatActivityLimits> = {
  quiet: { evaluationCooldownMs: 30_000, textCooldownMs: 120_000, reactionCooldownMs: 40_000, textPerWindow: 1, reactionsPerWindow: 3 },
  balanced: { evaluationCooldownMs: 25_000, textCooldownMs: 90_000, reactionCooldownMs: 30_000, textPerWindow: 3, reactionsPerWindow: 5 },
  lively: { evaluationCooldownMs: 20_000, textCooldownMs: 60_000, reactionCooldownMs: 20_000, textPerWindow: 3, reactionsPerWindow: 5 },
};

export interface ResolvedParticipation extends ParticipationSettings {
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
      continuationPerExchange: advanced.continuationPerExchange ?? 10,
      continuationPerWindow: advanced.continuationPer10Minutes ?? 30,
    },
  };
}

export function isLowSubstancePing(message: string, hasTarget: boolean, hasImages: boolean): boolean {
  return !hasTarget && !hasImages && /^(?:\s*|hi|hey|yo|hello|嗨|嘿|哈囉|[?!？！]+)$/iu.test(message.trim());
}
