import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import { PARTICIPATION_LIMITS } from "../../../../config/guild-configuration-limits.js";
import { action, channelList, choice, group, integer, toggle, report } from "../registry/builders.js";
import type { Patch, SettingOption } from "../registry/types.js";
import { chatSetting } from "./chat.js";
import { defaultParticipation, resolveParticipation, contributionPolicy, type DecisionContract, type ParticipationOverride, type ParticipationSettings } from "../../../../application/chat/participation-policy.js";
import { chatPolicyReport } from "./chat-policy-report.js";

// When the bot speaks without being asked: follow-ups in an exchange it's
// already part of, joining conversations, and the pacing both share.
// Direct mentions and name requests aren't governed here.

type Advanced = keyof ParticipationSettings["advanced"];
const activities = ["quiet", "balanced", "lively"] as const;

const contracts = ["inherit", "legacy", "simple"] as const;
const contractOf = (value: string): DecisionContract | undefined => value === "legacy" || value === "simple" ? value : undefined;
const percent = (value: number | undefined): number => Math.round((value ?? 0) * 100);

const configured = (p: GuildConfiguration): ParticipationSettings => p.chat.participation ?? defaultParticipation;
const limits = (p: GuildConfiguration): ReturnType<typeof resolveParticipation>["limits"] => resolveParticipation(p.chat.participation, "").limits;
const observed = (p: GuildConfiguration): readonly string[] => configured(p).observationChannelIds ?? [...p.channels.chatbot];

// A number whose default comes from a preset or policy. Saving the value
// already in effect stores nothing, so the preset keeps applying until an
// admin really overrides it.
function tuned(bounds: { min: number; max: number }, current: (p: GuildConfiguration) => number, patch: (value: number) => Patch): SettingOption {
  return integer({ min: bounds.min, max: bounds.max, read: current, write: (value, p) => value === current(p) ? {} : patch(value) });
}
const advanced = (field: Advanced) => (value: number): Patch => ({ chatParticipation: { advanced: { [field]: value } } });
const seconds = (ms: number | undefined): number => (ms ?? 0) / 1000;

export const participation = group("participation", [
  chatPolicyReport,
  report("status", ({ deps, profile, text, path }) => Promise.resolve(text.message(path, deps.characterRuntime?.decisionAvailable ? "available" : "paused") + "\n" +
    text.message(path, "scope", { count: observed(profile).length }) + "\n" + text.message(path, configured(profile).shadowMode ? "preview-on" : "preview-off"))),

  // Server-wide preview. A channel or thread can differ through `channel`;
  // the character's thoughts module has its own, separate preview.
  chatSetting("preview", {
    enabled: toggle({ read: (p) => configured(p).shadowMode, write: (v) => ({ chatParticipation: { shadowMode: v } }) }),
  }),

  chatSetting("observation-channels", {
    channels: channelList({ textOnly: true, read: (p) => [...observed(p)],
      write: (v, p) => JSON.stringify(v) === JSON.stringify(observed(p)) ? {} : ({ chatParticipation: { observationChannelIds: [...v] } }) }),
  }),

  chatSetting("follow-ups", {
    enabled: toggle({ read: (p) => configured(p).continuationEnabled, write: (v) => ({ chatParticipation: { continuationEnabled: v } }) }),
    threshold: tuned(PARTICIPATION_LIMITS.thresholdPercent, (p) => contributionPolicy(p.chat.participation).continuationThreshold * 100,
      (v) => ({ chatParticipation: { continuationThreshold: v / 100 } })),
    interval: tuned(PARTICIPATION_LIMITS.followUpIntervalSeconds, (p) => seconds(limits(p).continuationIntervalMs), advanced("continuationIntervalSeconds")),
    "per-exchange": tuned(PARTICIPATION_LIMITS.followUpsPerExchange, (p) => limits(p).continuationPerExchange ?? 0, advanced("continuationPerExchange")),
    "per-10-minutes": tuned(PARTICIPATION_LIMITS.followUpsPer10Minutes, (p) => limits(p).continuationPerWindow ?? 0, advanced("continuationPer10Minutes")),
  }),

  // Joining needs both the switch and the channel on the list; threads are
  // added through `channel`.
  chatSetting("joining", {
    enabled: toggle({ read: (p) => configured(p).spontaneousEnabled, write: (v) => ({ chatParticipation: { spontaneousEnabled: v } }) }),
    channels: channelList({ textOnly: true, read: (p) => [...configured(p).spontaneousChannelIds],
      write: (v) => ({ chatParticipation: { spontaneousChannelIds: [...v] } }) }),
    threshold: tuned(PARTICIPATION_LIMITS.thresholdPercent, (p) => contributionPolicy(p.chat.participation).spontaneousThreshold * 100,
      (v) => ({ chatParticipation: { spontaneousThreshold: v / 100 } })),
    "check-every": tuned(PARTICIPATION_LIMITS.joinEveryMessages, (p) => resolveParticipation(p.chat.participation, "").messagesPerDecision,
      (v) => ({ chatParticipation: { messagesPerDecision: v } })),
  }),

  // Which decision contract answers optional turns. Unset inherits the instance default.
  chatSetting("decision-contract", {
    contract: choice({ choices: contracts, read: (p) => configured(p).decisionContract ?? "inherit",
      write: (v, p) => v === (configured(p).decisionContract ?? "inherit") ? {} : { chatParticipation: { decisionContract: contractOf(v) } } }),
  }),

  // Probability gates on the native selected-action score for the simple contract. Zero disables.
  chatSetting("simple-threshold", {
    followup: integer({ min: 0, max: 100, read: (p) => percent(configured(p).simpleActionThresholds?.followup),
      write: (v, p) => v === percent(configured(p).simpleActionThresholds?.followup) ? {} : { chatParticipation: { simpleActionThresholds: { followup: v / 100 } } } }),
    joining: integer({ min: 0, max: 100, read: (p) => percent(configured(p).simpleActionThresholds?.joining),
      write: (v, p) => v === percent(configured(p).simpleActionThresholds?.joining) ? {} : { chatParticipation: { simpleActionThresholds: { joining: v / 100 } } } }),
  }),

  // The activity preset sets every pause and budget below; a number saved
  // here overrides the preset until `reset-limits`.
  chatSetting("pacing", {
    activity: choice({ choices: activities, read: (p) => configured(p).activity, write: (v) => ({ chatParticipation: { activity: v } }) }),
    evaluation: tuned(PARTICIPATION_LIMITS.evaluationCooldownSeconds, (p) => seconds(limits(p).evaluationCooldownMs), advanced("evaluationCooldownSeconds")),
    text: tuned(PARTICIPATION_LIMITS.textCooldownSeconds, (p) => seconds(limits(p).textCooldownMs), advanced("textCooldownSeconds")),
    reaction: tuned(PARTICIPATION_LIMITS.reactionCooldownSeconds, (p) => seconds(limits(p).reactionCooldownMs), advanced("reactionCooldownSeconds")),
    "text-budget": tuned(PARTICIPATION_LIMITS.textPer10Minutes, (p) => limits(p).textPerWindow, advanced("textPer10Minutes")),
    "reaction-budget": tuned(PARTICIPATION_LIMITS.reactionsPer10Minutes, (p) => limits(p).reactionsPerWindow, advanced("reactionsPer10Minutes")),
  }),

  chatSetting("bare-pings", {
    mode: choice({ choices: ["acknowledge", "personality"] as const, read: (p) => configured(p).barePingMode, write: (v) => ({ chatParticipation: { barePingMode: v } }) }),
  }),

  chatSetting("resources", {
    concurrency: tuned(PARTICIPATION_LIMITS.concurrency, (p) => limits(p).concurrency ?? PARTICIPATION_LIMITS.concurrency.default, advanced("concurrency")),
    "optional-turns": tuned(PARTICIPATION_LIMITS.optionalTurnsPer10Minutes,
      (p) => limits(p).optionalTurnsPerWindow ?? PARTICIPATION_LIMITS.optionalTurnsPer10Minutes.default, advanced("optionalTurnsPer10Minutes")),
  }),

  action("reset-limits", {
    params: {},
    run: ({ text, path }) => Promise.resolve({ ok: true, message: text.message(path, "done"), patch: { chatParticipationResetAdvanced: true } }),
  }),

  // One channel or thread. Parent channels never grant their threads, so a
  // thread is chosen here directly. Unset options are left as they are.
  action("channel", {
    params: {
      channel: { kind: "channel", textOnly: true, threads: true, required: true },
      observe: { kind: "toggle" }, joining: { kind: "toggle" }, preview: { kind: "toggle" },
      "follow-ups": { kind: "toggle" }, reactions: { kind: "toggle" },
      activity: { kind: "choice", choices: activities }, reset: { kind: "toggle" },
      "decision-contract": { kind: "choice", choices: contracts },
      "followup-threshold": { kind: "integer", min: 0, max: 100 }, "joining-threshold": { kind: "integer", min: 0, max: 100 },
    },
    run: ({ profile, values, text, path }) => {
      const channelId = values.getChannel("channel")?.id;
      if (!channelId) return Promise.resolve({ ok: false, message: text.message(path, "missing") });
      const settings = configured(profile);
      const observe = values.getBoolean("observe"); const joining = values.getBoolean("joining");
      const preview = values.getBoolean("preview"); const followUps = values.getBoolean("follow-ups");
      const reactions = values.getBoolean("reactions"); const reset = values.getBoolean("reset") === true;
      const activity = values.getString("activity") as ParticipationOverride["activity"] | null;
      const contract = values.getString("decision-contract");
      const followupThreshold = values.getInteger("followup-threshold"); const joiningThreshold = values.getInteger("joining-threshold");
      if (!reset && [observe, joining, preview, followUps, reactions, activity, contract, followupThreshold, joiningThreshold].every((value) => value === null)) {
        return Promise.resolve({ ok: false, message: text.message(path, "nothing") });
      }

      const observations = new Set(observed(profile));
      const joinable = new Set(settings.spontaneousChannelIds);
      if (observe === true) observations.add(channelId);
      if (observe === false) { observations.delete(channelId); joinable.delete(channelId); }
      if (joining === true && !observations.has(channelId)) return Promise.resolve({ ok: false, message: text.message(path, "needs-observation") });
      if (joining === true) joinable.add(channelId);
      if (joining === false) joinable.delete(channelId);

      // Joining is the server switch plus the list, so a stored per-channel
      // spontaneous flag from older builds is dropped once the list changes.
      const { spontaneousEnabled: _retired, ...kept } = settings.channelOverrides[channelId] ?? {};
      const override: ParticipationOverride = reset ? {} : {
        ...(joining === null ? settings.channelOverrides[channelId] : kept),
        ...(preview === null ? {} : { shadowMode: preview }),
        ...(followUps === null ? {} : { continuationEnabled: followUps }),
        ...(reactions === null ? {} : { reactionsEnabled: reactions }),
        ...(activity ? { activity } : {}),
      };
      if (!reset) {
        if (contract === "inherit") delete override.decisionContract; else if (contract) override.decisionContract = contractOf(contract)!;
        if (followupThreshold !== null || joiningThreshold !== null) override.simpleActionThresholds = { ...override.simpleActionThresholds,
          ...(followupThreshold === null ? {} : { followup: followupThreshold / 100 }), ...(joiningThreshold === null ? {} : { joining: joiningThreshold / 100 }) };
      }
      return Promise.resolve({ ok: true, message: text.message(path, "done", { channel: `<#${channelId}>` }), patch: { chatParticipation: {
        ...(observe === null ? {} : { observationChannelIds: [...observations] }),
        spontaneousChannelIds: [...joinable],
        channelOverrides: { [channelId]: override },
      } } });
    },
  }),
]);
