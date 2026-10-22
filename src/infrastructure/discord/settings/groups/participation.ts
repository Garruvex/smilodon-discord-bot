import { action, channelList, choice, group, integer, toggle, report } from "../registry/builders.js";
import { chatSetting } from "./chat.js";
import { defaultParticipation, resolveParticipation, contributionPolicy } from "../../../../application/chat/participation-policy.js";
import { chatPolicyReport } from "./chat-policy-report.js";

export const participation = group("participation", [
    chatPolicyReport,
    report("status", ({ deps, profile, text, path }) => Promise.resolve(text.message(path, deps.characterRuntime?.decisionAvailable ? "available" : "paused") + "\n" + text.message(path, "scope", { count: (profile.chat.participation?.observationChannelIds ?? [...profile.channels.chatbot]).length }))),
    chatSetting("observation-channels", {
      channels: channelList({ textOnly: true, read: (p) => [...(p.chat.participation?.observationChannelIds ?? p.channels.chatbot)],
        write: (v, p) => JSON.stringify(v) === JSON.stringify(p.chat.participation?.observationChannelIds ?? [...p.channels.chatbot]) ? {} : ({ chatParticipation: { observationChannelIds: [...v] } }) }),
    }),
    action("thread-scope", {
      params: { "thread-id": { kind: "text", maxLength: 20, required: true }, observe: { kind: "toggle" }, spontaneous: { kind: "toggle" }, shadow: { kind: "toggle" } },
      run: async ({ profile, request, values, text, path }) => {
        const id = values.getString("thread-id") ?? "";
        const observe = values.getBoolean("observe"); const spontaneous = values.getBoolean("spontaneous");
        const shadow = values.getBoolean("shadow");
        if (!/^\d{17,20}$/u.test(id) || !request.guild || observe === null && spontaneous === null && shadow === null) return { ok: false, message: text.message(path, "invalid") };
        const thread = await request.guild.channels.fetch(id).catch(() => null);
        if (!thread?.isThread() || thread.guildId !== profile.guildId) return { ok: false, message: text.message(path, "invalid") };
        const observations = new Set(profile.chat.participation?.observationChannelIds ?? profile.channels.chatbot);
        const spontaneousChannels = new Set(profile.chat.participation?.spontaneousChannelIds ?? []);
        if (observe === true) observations.add(id); else if (observe === false) observations.delete(id);
        if (spontaneous === true && !observations.has(id)) return { ok: false, message: text.message(path, "needs-observation") };
        if (spontaneous === true) spontaneousChannels.add(id); else if (spontaneous === false || observe === false) spontaneousChannels.delete(id);
        const override = { ...profile.chat.participation?.channelOverrides[id], ...(shadow === null ? {} : { shadowMode: shadow }) };
        return { ok: true, message: text.message(path, "done"), patch: { chatParticipation: { observationChannelIds: [...observations], spontaneousChannelIds: [...spontaneousChannels],
          ...(shadow !== null ? { channelOverrides: { [id]: override } } : {}) } } };
      },
    }),
    chatSetting("continuation-limits", {
      interval: integer({ min: 15, max: 600, read: (p) => resolveParticipation(p.chat.participation, "").limits.continuationIntervalMs! / 1000,
        write: (v, p) => v === resolveParticipation(p.chat.participation, "").limits.continuationIntervalMs! / 1000 ? {} : ({ chatParticipation: { advanced: { continuationIntervalSeconds: v } } }) }),
      exchange: integer({ min: 0, max: 30, read: (p) => p.chat.participation?.advanced.continuationPerExchange ?? resolveParticipation(p.chat.participation, "").limits.continuationPerExchange!,
        write: (v, p) => v === resolveParticipation(p.chat.participation, "").limits.continuationPerExchange! ? {} : ({ chatParticipation: { advanced: { continuationPerExchange: v } } }) }),
      window: integer({ min: 0, max: 100, read: (p) => p.chat.participation?.advanced.continuationPer10Minutes ?? resolveParticipation(p.chat.participation, "").limits.continuationPerWindow!,
        write: (v, p) => v === resolveParticipation(p.chat.participation, "").limits.continuationPerWindow! ? {} : ({ chatParticipation: { advanced: { continuationPer10Minutes: v } } }) }),
    }),
    chatSetting("controls", {
      "messages-per-decision": integer({ min: 1, max: 20, read: (p) => resolveParticipation(p.chat.participation, "").messagesPerDecision,
        write: (v, p) => v === resolveParticipation(p.chat.participation, "").messagesPerDecision ? {} : ({ chatParticipation: { messagesPerDecision: v } }) }),
      "spontaneous-threshold": integer({ min: 0, max: 100, read: (p) => contributionPolicy(p.chat.participation).spontaneousThreshold * 100,
        write: (v, p) => v / 100 === contributionPolicy(p.chat.participation).spontaneousThreshold ? {} : ({ chatParticipation: { spontaneousThreshold: v / 100 } }) }),
      "continuation-threshold": integer({ min: 0, max: 100, read: (p) => contributionPolicy(p.chat.participation).continuationThreshold * 100,
        write: (v, p) => v / 100 === contributionPolicy(p.chat.participation).continuationThreshold ? {} : ({ chatParticipation: { continuationThreshold: v / 100 } }) }),
      continuation: toggle({ read: (p) => p.chat.participation?.continuationEnabled ?? false, write: (v) => ({ chatParticipation: { continuationEnabled: v } }) }),
      spontaneous: toggle({ read: (p) => p.chat.participation?.spontaneousEnabled ?? false, write: (v) => ({ chatParticipation: { spontaneousEnabled: v } }) }),
      activity: choice({ choices: ["quiet", "balanced", "lively"] as const, read: (p) => p.chat.participation?.activity ?? "balanced", write: (v) => ({ chatParticipation: { activity: v } }) }),
      "bare-pings": choice({ choices: ["acknowledge", "personality"] as const, read: (p) => p.chat.participation?.barePingMode ?? "acknowledge", write: (v) => ({ chatParticipation: { barePingMode: v } }) }),
      shadow: toggle({ read: (p) => p.chat.participation?.shadowMode ?? false, write: (v) => ({ chatParticipation: { shadowMode: v } }) }),
    }),
    chatSetting("spontaneous-channels", {
      channels: channelList({ textOnly: true, read: (p) => [...(p.chat.participation?.spontaneousChannelIds ?? [])],
        write: (v) => ({ chatParticipation: { spontaneousChannelIds: [...v] } }) }),
    }),
    chatSetting("resources", {
      concurrency: integer({ min: 1, max: 16, read: (p) => p.chat.participation?.advanced.concurrency ?? 4,
        write: (v, p) => v === (p.chat.participation?.advanced.concurrency ?? 4) ? {} : ({ chatParticipation: { advanced: { concurrency: v } } }) }),
      "optional-turns": integer({ min: 0, max: 1000, read: (p) => p.chat.participation?.advanced.optionalTurnsPer10Minutes ?? 100,
        write: (v, p) => v === (p.chat.participation?.advanced.optionalTurnsPer10Minutes ?? 100) ? {} : ({ chatParticipation: { advanced: { optionalTurnsPer10Minutes: v } } }) }),
    }),
    chatSetting("activity-limits", {
      evaluation: integer({ min: 20, max: 600, read: (p) => resolveParticipation(p.chat.participation, "").limits.evaluationCooldownMs / 1000,
        write: (v, p) => v === resolveParticipation(p.chat.participation, "").limits.evaluationCooldownMs / 1000 ? {} : ({ chatParticipation: { advanced: { evaluationCooldownSeconds: v } } }) }),
      text: integer({ min: 60, max: 3600, read: (p) => resolveParticipation(p.chat.participation, "").limits.textCooldownMs / 1000,
        write: (v, p) => v === resolveParticipation(p.chat.participation, "").limits.textCooldownMs / 1000 ? {} : ({ chatParticipation: { advanced: { textCooldownSeconds: v } } }) }),
      reaction: integer({ min: 20, max: 600, read: (p) => resolveParticipation(p.chat.participation, "").limits.reactionCooldownMs / 1000,
        write: (v, p) => v === resolveParticipation(p.chat.participation, "").limits.reactionCooldownMs / 1000 ? {} : ({ chatParticipation: { advanced: { reactionCooldownSeconds: v } } }) }),
      "text-budget": integer({ min: 0, max: 3, read: (p) => resolveParticipation(p.chat.participation, "").limits.textPerWindow,
        write: (v, p) => v === resolveParticipation(p.chat.participation, "").limits.textPerWindow ? {} : ({ chatParticipation: { advanced: { textPer10Minutes: v } } }) }),
      "reaction-budget": integer({ min: 0, max: 5, read: (p) => resolveParticipation(p.chat.participation, "").limits.reactionsPerWindow,
        write: (v, p) => v === resolveParticipation(p.chat.participation, "").limits.reactionsPerWindow ? {} : ({ chatParticipation: { advanced: { reactionsPer10Minutes: v } } }) }),
    }),
    action("participation-channel", {
      params: { channel: { kind: "channel", textOnly: true, required: true },
        shadow: { kind: "toggle" },
        continuation: { kind: "toggle" }, spontaneous: { kind: "toggle" }, reactions: { kind: "toggle" },
        activity: { kind: "choice", choices: ["quiet", "balanced", "lively"] }, reset: { kind: "toggle" } },
      run: ({ profile, values, text, path }) => {
        const channelId = values.getChannel("channel")?.id;
        if (!channelId) return Promise.resolve({ ok: false, message: text.message(path, "missing") });
        const configured = profile.chat.participation ?? defaultParticipation;
        const override = { ...configured.channelOverrides[channelId] };
        const shadow = values.getBoolean("shadow");
        if (shadow !== null) override.shadowMode = shadow;
        const continuation = values.getBoolean("continuation");
        const spontaneous = values.getBoolean("spontaneous");
        const reactions = values.getBoolean("reactions");
        const activity = values.getString("activity") as "quiet" | "balanced" | "lively" | null;
        if (continuation !== null) override.continuationEnabled = continuation;
        if (spontaneous !== null) override.spontaneousEnabled = spontaneous;
        if (reactions !== null) override.reactionsEnabled = reactions;
        if (activity) override.activity = activity;
        return Promise.resolve({ ok: true, message: text.message(path, "done", { channel: `<#${channelId}>` }),
          patch: { chatParticipation: { channelOverrides: { [channelId]: values.getBoolean("reset") ? {} : override } } } });
      },
    }),
    action("activity-reset", {
      params: {},
      run: ({ text, path }) => Promise.resolve({ ok: true, message: text.message(path, "done"),
        patch: { chatParticipationResetAdvanced: true } }),
    }),
]);
