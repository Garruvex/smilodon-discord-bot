import { z } from "zod";
import type { GuildConfiguration } from "../../config/guild-configuration.js";

export const characterModuleIds = ["canon", "relationships", "thoughts", "recall-style", "callbacks", "fading", "voice", "message-shape", "mood", "addressing", "group", "daily-sketch", "evaluation"] as const;
export type CharacterModuleId = typeof characterModuleIds[number];
const baseControls = z.object({ enabled: z.boolean().default(false), budget: z.number().int().min(100).max(4000).default(800) });
const interval = z.number().int().min(1).max(1440);
const retention = z.number().int().min(1).max(365).default(90);
export const characterModuleSchemas = {
  canon: baseControls.extend({ freeze: z.boolean().default(false), retentionDays: retention }).default({}),
  // retentionDays is a deprecated configuration read path; new impressions never use it.
  relationships: baseControls.extend({ intervalMinutes: interval.default(30), retentionDays: retention }).default({}),
  thoughts: baseControls.extend({ shadow: z.boolean().default(true), threshold: z.number().min(0).max(1).default(0.7), holdSeconds: z.number().int().min(5).max(600).default(120) }).default({}),
  "recall-style": baseControls.default({}),
  callbacks: baseControls.extend({ maxPerDay: z.number().int().min(0).max(10).default(1), minDelayMinutes: z.number().int().min(0).max(1440).default(60) }).default({}),
  fading: baseControls.extend({ halfLifeDays: z.number().int().min(1).max(365).default(30) }).default({}),
  voice: baseControls.extend({ strictness: z.enum(["trim", "regenerate"]).default("trim") }).default({}),
  "message-shape": baseControls.extend({ maxMessages: z.number().int().min(1).max(3).default(1), maxDelayMs: z.number().int().min(0).max(5000).default(0) }).default({}),
  mood: baseControls.extend({ intervalMinutes: interval.default(30) }).default({}),
  addressing: baseControls.extend({ shadow: z.boolean().default(true), includeOtherParticipants: z.boolean().default(true) }).default({}),
  group: baseControls.default({}),
  "daily-sketch": baseControls.default({}),
  evaluation: baseControls.extend({ probes: z.boolean().default(false), intervalMinutes: z.number().int().min(60).max(1440).default(1440) }).default({}),
};
export const characterSettingsSchema = z.object({
  enabled: z.boolean().default(false), modules: z.object(characterModuleSchemas).default({}),
  channelOverrides: z.record(z.string().regex(/^\d{17,20}$/), z.object({
    enabled: z.boolean().optional(), modules: z.record(z.enum(characterModuleIds), z.boolean()).default({}),
    contextEnabled: z.boolean().optional(),
  })).default({}),
  context: z.object({
    enabled: z.boolean().default(false), windowMinutes: z.number().int().min(1).max(20).default(15),
    segmentGapMinutes: z.number().int().min(1).max(20).default(10),
    maxMessages: z.number().int().min(8).max(48).default(40), budget: z.number().int().min(2000).max(24000).default(12000),
    summary: z.boolean().default(false), shadow: z.boolean().default(true), decisionMessages: z.number().int().min(5).max(20).default(10),
  }).default({}),
}).default({});
export type CharacterSettings = z.infer<typeof characterSettingsSchema>;
export type CharacterSettingsPatch = Partial<Omit<CharacterSettings, "modules">> & { modules?: { [K in CharacterModuleId]?: Partial<CharacterSettings["modules"][K]> } };
export const defaultCharacterSettings = characterSettingsSchema.parse({});
export function characterSettings(profile: GuildConfiguration): CharacterSettings {
  return profile.character ?? defaultCharacterSettings;
}
export interface CharacterCapabilities { decision: boolean; context: boolean; memorySharing: boolean; continuation: boolean; spontaneous: boolean; excluded: boolean }
export const characterDependencies: Partial<Record<CharacterModuleId, readonly string[]>> = {
  relationships: ["memorySharing"], callbacks: ["memorySharing", "continuation"],
  thoughts: ["context", "addressing", "decision", "participation"], addressing: ["context", "continuation"],
  group: ["context"], "daily-sketch": ["canon"],
};
export function characterInactiveReason(settings: CharacterSettings, id: CharacterModuleId, channelId: string, capabilities: CharacterCapabilities, visited = new Set<string>()): string | null {
  if (capabilities.excluded) return "excluded";
  if (id !== "evaluation" && (!settings.enabled || settings.channelOverrides[channelId]?.enabled === false)) return "master_disabled";
  if (!settings.modules[id].enabled || settings.channelOverrides[channelId]?.modules[id] === false) return "module_disabled";
  if (visited.has(id)) return "dependency_cycle";
  visited.add(id);
  for (const dependency of characterDependencies[id] ?? []) {
    if (characterModuleIds.includes(dependency as CharacterModuleId)) {
      const reason = characterInactiveReason(settings, dependency as CharacterModuleId, channelId, capabilities, new Set(visited));
      if (reason) return `needs_${dependency}`;
    } else if (dependency === "participation" ? !capabilities.continuation && !capabilities.spontaneous : !capabilities[dependency as keyof CharacterCapabilities]) return `needs_${dependency}`;
  }
  return null;
}
