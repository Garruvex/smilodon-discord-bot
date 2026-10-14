import { action, choice, group, integer, report, setting, toggle } from "../registry/builders.js";
import { characterModuleIds, characterSettings, type CharacterModuleId } from "../../../../application/chat/character-settings.js";
import type { SettingNode, SettingOption } from "../registry/types.js";

const extras: Partial<Record<CharacterModuleId, readonly string[]>> = {
  canon: ["freeze"], relationships: ["interval"], thoughts: ["shadow", "threshold", "hold"],
  callbacks: ["max-per-day", "min-delay"], fading: ["half-life"], voice: ["strictness"],
  "message-shape": ["max-messages", "max-delay"], mood: ["interval"], addressing: ["shadow", "include-others"],
  evaluation: ["probes", "interval"],
};
function moduleSetting(id: CharacterModuleId): SettingNode {
  const options: Record<string, SettingOption> = {
    enabled: toggle({ read: (p) => characterSettings(p).modules[id].enabled, write: (v) => ({ character: { modules: { [id]: { enabled: v } } } }) }),
    budget: integer({ min: 100, max: 4000, read: (p) => characterSettings(p).modules[id].budget, write: (v) => ({ character: { modules: { [id]: { budget: v } } } }) }),
  };
  if (id === "canon") options.freeze = toggle({ read: (p) => characterSettings(p).modules.canon.freeze, write: (v) => ({ character: { modules: { canon: { freeze: v } } } }) });
  if (id === "thoughts" || id === "addressing") options.shadow = toggle({ read: (p) => characterSettings(p).modules[id].shadow, write: (v) => ({ character: { modules: { [id]: { shadow: v } } } }) });
  if (id === "addressing") options["include-others"] = toggle({ read: (p) => characterSettings(p).modules.addressing.includeOtherParticipants, write: (v) => ({ character: { modules: { addressing: { includeOtherParticipants: v } } } }) });
  if (id === "evaluation") options.probes = toggle({ read: (p) => characterSettings(p).modules.evaluation.probes, write: (v) => ({ character: { modules: { evaluation: { probes: v } } } }) });
  const numbers = { interval: ["intervalMinutes", 1, 1440], threshold: ["threshold", 0, 100], hold: ["holdSeconds", 5, 600],
    "max-per-day": ["maxPerDay", 0, 10], "min-delay": ["minDelayMinutes", 0, 1440], "half-life": ["halfLifeDays", 1, 365],
    "max-messages": ["maxMessages", 1, 3], "max-delay": ["maxDelayMs", 0, 5000] } as const;
  for (const option of extras[id] ?? []) if (option in numbers) {
    const [field, min, max] = numbers[option as keyof typeof numbers];
    options[option] = integer({ min: id === "evaluation" && option === "interval" ? 60 : min, max, read: (p) => {
      const controls: Record<string, unknown> = characterSettings(p).modules[id]; const value = controls[field];
      if (typeof value !== "number") throw new Error(`Missing numeric character setting: ${id}.${field}`);
      return value * (field === "threshold" ? 100 : 1);
    },
      write: (v) => ({ character: { modules: { [id]: { [field]: field === "threshold" ? v / 100 : v } } } }) });
  }
  if (id === "voice") options.strictness = choice({ choices: ["trim", "regenerate"] as const,
    read: (p) => characterSettings(p).modules.voice.strictness, write: (v) => ({ character: { modules: { voice: { strictness: v } } } }) });
  return setting(id, options);
}
export const character = group("character", [
  setting("controls", { enabled: toggle({ read: (p) => characterSettings(p).enabled, write: (v) => ({ character: { enabled: v } }) }) }),
  setting("context", {
    enabled: toggle({ read: (p) => characterSettings(p).context.enabled && p.features.channelHistory, write: (v, p) => ({ channelHistory: v, character: { context: { ...characterSettings(p).context, enabled: v } } }) }),
    minutes: integer({ min: 1, max: 20, read: (p) => characterSettings(p).context.windowMinutes, write: (v, p) => ({ character: { context: { ...characterSettings(p).context, windowMinutes: v } } }) }),
    gap: integer({ min: 1, max: 20, read: (p) => characterSettings(p).context.segmentGapMinutes, write: (v, p) => ({ character: { context: { ...characterSettings(p).context, segmentGapMinutes: v } } }) }),
    messages: integer({ min: 8, max: 48, read: (p) => characterSettings(p).context.maxMessages, write: (v, p) => ({ character: { context: { ...characterSettings(p).context, maxMessages: v } } }) }),
    budget: integer({ min: 2000, max: 24000, read: (p) => characterSettings(p).context.budget, write: (v, p) => ({ character: { context: { ...characterSettings(p).context, budget: v } } }) }),
    summary: toggle({ read: (p) => characterSettings(p).context.summary, write: (v, p) => ({ character: { context: { ...characterSettings(p).context, summary: v } } }) }),
    shadow: toggle({ read: (p) => characterSettings(p).context.shadow, write: (v, p) => ({ character: { context: { ...characterSettings(p).context, shadow: v } } }) }),
    "decision-messages": integer({ min: 5, max: 20, read: (p) => characterSettings(p).context.decisionMessages, write: (v, p) => ({ character: { context: { ...characterSettings(p).context, decisionMessages: v } } }) }),
  }),
  ...characterModuleIds.map(moduleSetting),
  action("channel", { params: { channel: { kind: "channel", textOnly: true, required: true }, module: { kind: "choice", choices: ["master", "context", ...characterModuleIds], required: true }, enabled: { kind: "toggle", required: true }, reset: { kind: "toggle" } },
    run: ({ profile, values, text: labels, path }) => {
      const channelId = values.getChannel("channel")?.id;
      const id = values.getString("module") as CharacterModuleId | "master" | "context" | null;
      if (!channelId || !id) return Promise.resolve({ ok: false, message: labels.message(path, "missing") });
      const previous = characterSettings(profile).channelOverrides[channelId] ?? { modules: {} };
      if (id === "master" || id === "context") {
        const override = { ...previous }; const field = id === "master" ? "enabled" : "contextEnabled";
        if (values.getBoolean("reset")) delete override[field]; else override[field] = values.getBoolean("enabled") ?? false;
        return Promise.resolve({ ok: true, message: labels.message(path, "done"), patch: { character: { channelOverrides: { [channelId]: override } } } });
      }
      const modules = { ...previous.modules };
      if (values.getBoolean("reset")) delete modules[id]; else modules[id] = values.getBoolean("enabled") ?? false;
      return Promise.resolve({ ok: true, message: labels.message(path, "done"), patch: { character: { channelOverrides: { [channelId]: { ...previous, modules } } } } });
    } }),
  action("ledger", { params: { operation: { kind: "choice", choices: ["list", "edit", "delete", "clear"], required: true }, module: { kind: "choice", choices: ["canon", "mood", "daily-sketch"] },
    channel: { kind: "channel", textOnly: true }, id: { kind: "text", maxLength: 100 }, statement: { kind: "text", maxLength: 200 } },
    run: async ({ deps, request, values, text: labels, path }) => {
      if (!deps.characterRuntime) return { ok: false, message: labels.message(path, "unavailable") };
      const moduleId = (values.getString("module") ?? "canon") as "canon" | "mood" | "daily-sketch";
      const result = await deps.characterRuntime.manageCanon(request.guildId, request.actorUserId, values.getChannel("channel")?.id ?? "", values.getString("operation") ?? "list", values.getString("id"), values.getString("statement"), moduleId);
      return { ok: true, message: result };
    } }),
  report("status", ({ profile, deps, values }) => {
    const channelId = values.getChannel("channel")?.id ?? "";
    return Promise.resolve(deps.characterRuntime?.describeStatus(profile, channelId) ?? "Character runtime is unavailable.");
  }, { channel: { kind: "channel", textOnly: true } }),
]);
