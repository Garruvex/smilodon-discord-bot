import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { AttachmentBuilder } from "discord.js";

import { CHAT_LIMITS } from "../../../../config/guild-configuration-limits.js";
import {
  action,
  channelList,
  groupWithSections,
  integer,
  report,
  section,
  setting,
  text,
  toggle,
  upload,
} from "../registry/builders.js";
import type { NodeContext, SettingNode } from "../registry/types.js";
import { renderContextStatus } from "./chat-context-status.js";

// Every chat setting but the on/off switch itself says so when the chatbot
// is off, since the change then has no effect until it's turned back on.
const chatSetting = (
  name: string,
  options: SettingNode["options"],
  extras: Omit<SettingNode, "kind" | "name" | "options"> = {},
): SettingNode => setting(name, options, {
  extraLines: ({ previous, updated, text }) =>
    !updated.features.chatbot && !isDeepStrictEqual(previous, updated) ? [text.message("chat", "paused")] : [],
  ...extras,
});

const enabledToggle = (
  read: Parameters<typeof toggle>[0]["read"],
  write: Parameters<typeof toggle>[0]["write"],
): SettingNode["options"] => ({ enabled: toggle({ read, write }) });

// Repo-committed starter files (the ones docs/personality-guide.md
// documents), read per request so there's one copy of each to keep in sync.
const templates = {
  personality: { path: "config/examples/personality.example.md", filename: "personality.md" },
  examples: { path: "config/examples/examples.example.md", filename: "examples.md" },
} as const;

const summarizationUnavailable = ({ deps, text, path }: NodeContext): string | null =>
  deps.channelSummaryProviderAvailable ? null : text.message(path, "unavailable");

const pausedSuffix = ({ profile, text }: NodeContext): string =>
  profile.features.chatbot ? "" : `\n${text.message("chat", "paused")}`;

// One of the model's tools, enabled or disabled by name. A plain text
// parameter rather than choices: the tool list comes from the live
// registry, which slash metadata can't know when it's built.
const toolSwitch = action("tool", {
  params: {
    name: { kind: "text", maxLength: 100, required: true },
    enabled: { kind: "toggle", required: true },
  },
  run: ({ deps, profile, text, path, values }) => {
    const tool = values.getString("name")?.trim() ?? "";
    const enable = values.getBoolean("enabled") === true;
    const known = (deps.chatToolRegistry?.list() ?? []).map((candidate) => candidate.name);
    if (!known.includes(tool)) {
      return Promise.resolve({
        ok: false,
        message: text.message(path, "unknown", { name: tool, available: known.sort().join(", ") || "—" }),
      });
    }
    const disabled = new Set(profile.chat.disabledTools);
    if (enable) disabled.delete(tool);
    else disabled.add(tool);
    const list = [...disabled].sort();
    return Promise.resolve({
      ok: true,
      message: text.message(path, "done", { disabled: list.length > 0 ? list.join(", ") : "—" }),
      patch: { chatbotDisabledToolNames: list },
    });
  },
});

// Tool descriptions are written for the model and keep growing; one short
// line each keeps the listing's size bounded by the number of tools.
const maxToolDescription = 100;

function summarizeToolDescription(description: string): string {
  if (description.length <= maxToolDescription) return description;
  const truncated = description.slice(0, maxToolDescription);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, lastSpace > 0 ? lastSpace : maxToolDescription)}…`;
}

export const chat = groupWithSections("chat", [
  section("replies", [
    setting("mention-chat", {
      enabled: toggle({ read: (p) => p.features.chatbot, write: (v) => ({ chatbotEnabled: v }) }),
      channels: channelList({
        textOnly: true,
        read: (p) => [...p.channels.chatbot],
        write: (v) => ({ chatbotChannelIds: [...v] }),
      }),
      "cooldown-seconds": integer({
        min: CHAT_LIMITS.cooldownSeconds.min,
        max: CHAT_LIMITS.cooldownSeconds.max,
        read: (p) => p.chat.cooldownSeconds,
        write: (v) => ({ chatbotCooldownSeconds: v }),
      }),
    }, { setup: true }),

    chatSetting("denied-message", {
      message: text({
        maxLength: 500,
        read: (p) => p.chat.deniedMessage,
        write: (v) => ({ chatbotDeniedMessage: v.trim() }),
      }),
      "link-url": text({
        maxLength: 500,
        read: (p) => p.chat.deniedLinkUrl,
        // "none" removes the link button.
        write: (v) => ({ chatbotDeniedLinkUrl: v.trim().toLowerCase() === "none" ? null : v.trim() }),
        validate: (v, context) =>
          v.trim().toLowerCase() === "none" || /^https:\/\/\S+$/.test(v.trim()) ? null : context.error("not-https"),
      }),
      "link-label": text({
        maxLength: 80,
        read: (p) => p.chat.deniedLinkLabel,
        write: (v) => ({ chatbotDeniedLinkLabel: v.trim() }),
      }),
    }),

    chatSetting("ambient-replies", {
      enabled: toggle({ read: (p) => p.features.ambientReplies, write: (v) => ({ ambientReplies: v }) }),
      "cooldown-seconds": integer({
        min: CHAT_LIMITS.ambientCooldownSeconds.min,
        max: CHAT_LIMITS.ambientCooldownSeconds.max,
        read: (p) => p.chat.ambientCooldownSeconds,
        write: (v) => ({ ambientCooldownSeconds: v }),
      }),
    }),

    chatSetting("reaction-replies", {
      enabled: toggle({ read: (p) => p.features.reactionReplies, write: (v) => ({ reactionReplies: v }) }),
      "min-wait": integer({
        min: CHAT_LIMITS.reactionReplyWaitMinMinutes.min,
        max: CHAT_LIMITS.reactionReplyWaitMinMinutes.max,
        read: (p) => p.chat.reactionReplyWaitMinMinutes,
        write: (v) => ({ reactionReplyWaitMinMinutes: v }),
      }),
      "max-wait": integer({
        min: CHAT_LIMITS.reactionReplyWaitMaxMinutes.min,
        max: CHAT_LIMITS.reactionReplyWaitMaxMinutes.max,
        read: (p) => p.chat.reactionReplyWaitMaxMinutes,
        write: (v) => ({ reactionReplyWaitMaxMinutes: v }),
      }),
    }, {
      validate: (patch, context) => {
        const min = patch.reactionReplyWaitMinMinutes ?? context.profile.chat.reactionReplyWaitMinMinutes;
        const max = patch.reactionReplyWaitMaxMinutes ?? context.profile.chat.reactionReplyWaitMaxMinutes;
        return min > max ? context.error("wait-order", { min, max }) : null;
      },
    }),
    chatSetting("history-reactions", enabledToggle((p) => p.features.historyReactions, (v) => ({ historyReactions: v }))),
  ]),

  section("abilities", [
    chatSetting("web-search", enabledToggle(
      (p) => p.chat.webSearchMode === "auto",
      (v) => ({ chatbotWebSearchMode: v ? "auto" : "off" }),
    ), { setup: true }),
    chatSetting("include-sources", enabledToggle((p) => p.chat.includeSources, (v) => ({ chatbotIncludeSources: v }))),
    chatSetting("tool-calling", enabledToggle((p) => p.chat.toolCallingEnabled, (v) => ({ chatbotToolCallingEnabled: v }))),
    chatSetting("image-input", {
      enabled: toggle({ read: (p) => p.chat.imageInputEnabled, write: (v) => ({ chatbotImageInputEnabled: v }) }),
      "max-images": integer({
        min: CHAT_LIMITS.maxImagesPerRequest.min,
        max: CHAT_LIMITS.maxImagesPerRequest.max,
        read: (p) => p.chat.maxImagesPerRequest,
        write: (v) => ({ chatbotMaxImagesPerRequest: v }),
      }),
    }),
    chatSetting("image-generation", enabledToggle(
      (p) => p.chat.imageGenerationEnabled,
      (v) => ({ chatbotImageGenerationEnabled: v }),
    )),

    report("tools", ({ deps, profile, text, path }) => {
      const tools = deps.chatToolRegistry?.list() ?? [];
      if (tools.length === 0) return Promise.resolve(text.message(path, "none"));
      const disabled = new Set(profile.chat.disabledTools);
      const lines = tools.map((tool) =>
        `${disabled.has(tool.name) ? "🔴" : "🟢"} **${tool.name}** — ${summarizeToolDescription(tool.description)}`);
      return Promise.resolve([text.message(path, "heading"), ...lines].join("\n"));
    }),
    toolSwitch,
  ]),

  section("memory", [
    chatSetting("channel-history", {
      enabled: toggle({ read: (p) => p.features.channelHistory, write: (v) => ({ channelHistory: v }) }),
      limit: integer({
        min: CHAT_LIMITS.channelHistoryLimit.min,
        max: CHAT_LIMITS.channelHistoryLimit.max,
        read: (p) => p.chat.channelHistoryLimit,
        write: (v) => ({ channelHistoryLimit: v }),
      }),
    }),

    // Whether a channel's memory can ever become guild-wide: the model's own
    // scoping is only advisory (see memory-channel-policy.ts).
    action("memory-mode", {
      params: {
        channel: { kind: "channel", textOnly: true, required: true },
        mode: { kind: "choice", choices: ["shared", "isolated", "session_only", "disabled"], required: true },
      },
      run: ({ profile, text, path, values }) => {
        const channelId = values.getChannel("channel")?.id;
        const mode = values.getString("mode") as "shared" | "isolated" | "session_only" | "disabled" | null;
        if (!channelId || !mode) return Promise.resolve({ ok: false, message: text.message(path, "missing") });
        return Promise.resolve({
          ok: true,
          message: text.message(path, "done", { channel: `<#${channelId}>`, mode: text.choice(`${path}.mode`, mode) }),
          patch: { chatbotChannelMemoryModes: { ...profile.chat.channelMemoryModes, [channelId]: mode } },
        });
      },
    }),

    // Ongoing daily summaries into channel memory.
    chatSetting("context-daily", {
      channels: channelList({
        textOnly: true,
        read: (p) => [...p.chat.contextDailyChannelIds],
        write: (v) => ({ contextDailyChannelIds: [...v] }),
        validate: (v, context) => {
          const adding = v.some((id) => !context.profile.chat.contextDailyChannelIds.includes(id));
          return adding && !context.deps.channelSummaryProviderAvailable ? context.error("unavailable") : null;
        },
      }),
    }),

    // A one-time read of past history, folded into memory. Runs on the
    // summary scheduler's next tick; re-adding a queued channel reports its
    // state, and only `restart` re-reads a completed one.
    action("context-scan", {
      params: {
        channel: { kind: "channel", textOnly: true, required: true },
        "seed-days": { kind: "integer", min: 1, max: 90 },
        restart: { kind: "toggle" },
      },
      run: async (context) => {
        const { deps, profile, text, path, values } = context;
        const unavailable = summarizationUnavailable(context);
        if (unavailable) return { ok: false, message: unavailable };
        const channelId = values.getChannel("channel")?.id;
        if (!channelId) return { ok: false, message: text.message(path, "missing") };
        const seedDays = values.getInteger("seed-days");

        const queued = profile.chat.contextScanChannelIds.includes(channelId);
        if (queued) {
          const checkpoint = await deps.channelSummaryCheckpointStore?.get(profile.guildId, channelId) ?? null;
          if (checkpoint?.scanCompletedAt == null) return { ok: false, message: text.message(path, "in-progress") };
          if (values.getBoolean("restart") !== true) return { ok: false, message: text.message(path, "completed") };
          await deps.channelSummaryCheckpointStore?.resetScan(profile.guildId, channelId, Date.now());
        }
        return {
          ok: true,
          message: text.message(path, queued ? "restarted" : "queued", { channel: `<#${channelId}>` }) + pausedSuffix(context),
          patch: { contextScanAddChannelId: channelId, ...(seedDays !== null ? { contextSeedDays: seedDays } : {}) },
        };
      },
    }),

    action("context-remove", {
      params: { channel: { kind: "channel", textOnly: true, required: true } },
      run: ({ text, path, values }) => {
        const channelId = values.getChannel("channel")?.id;
        if (!channelId) return Promise.resolve({ ok: false, message: text.message(path, "missing") });
        return Promise.resolve({
          ok: true,
          message: text.message(path, "done", { channel: `<#${channelId}>` }),
          patch: { contextRemoveChannelId: channelId },
        });
      },
    }),

    report("context-status", renderContextStatus, {
      channel: { kind: "channel", textOnly: true },
    }),
  ]),

  section("persona", [
    chatSetting("personality", {
      file: upload({
        read: (p) => p.chat.personalityAsset,
        save: async (attachment, { guildId, deps, text, path }) => {
          const saved = await deps.assets.savePersonality(guildId, attachment);
          const lore = saved.loreHeadings;
          return {
            patch: { chatbotPersonalityAsset: saved.assetPath, chatbotPersonalityFile: null },
            // Which `##` sections were set aside as situational lore, so an
            // admin notices one that should always apply.
            notes: lore.length > 0 ? [text.message(path, "lore", { count: lore.length, headings: lore.join(", ") })] : [],
          };
        },
      }),
    }),
    action("use-default-personality", {
      params: {},
      run: ({ text, path }) => Promise.resolve({
        ok: true,
        message: text.message(path, "done"),
        patch: { chatbotPersonalityAsset: null, chatbotPersonalityFile: null },
      }),
    }),

    chatSetting("examples", {
      file: upload({
        read: (p) => p.chat.examplesAsset,
        save: async (attachment, { guildId, deps }) => ({
          patch: { chatbotExamplesAsset: await deps.assets.saveExamples(guildId, attachment), chatbotExamplesFile: null },
        }),
      }),
    }),
    action("use-default-examples", {
      params: {},
      run: ({ text, path }) => Promise.resolve({
        ok: true,
        message: text.message(path, "done"),
        patch: { chatbotExamplesAsset: null, chatbotExamplesFile: null },
      }),
    }),

    action("template", {
      params: { kind: { kind: "choice", choices: ["personality", "examples"], required: true } },
      run: ({ text, path, values }) => {
        const kind = values.getString("kind") === "examples" ? "examples" : "personality";
        const template = templates[kind];
        const content = readFileSync(resolve(template.path), "utf8");
        return Promise.resolve({
          ok: true,
          message: text.message(path, "done", { file: template.filename, command: `/settings-chat persona ${kind} file:<file>` }),
          files: [new AttachmentBuilder(Buffer.from(content, "utf8"), { name: template.filename })],
        });
      },
    }),

    chatSetting("self-reference-image", {
      image: upload({
        read: (p) => p.chat.selfReferenceImageAsset,
        save: async (attachment, { guildId, deps }) => ({
          patch: { chatbotSelfReferenceImageAsset: await deps.assets.saveSelfReferenceImage(guildId, attachment) },
        }),
      }),
    }),
    action("remove-self-reference-image", {
      params: {},
      run: ({ text, path }) => Promise.resolve({
        ok: true,
        message: text.message(path, "done"),
        patch: { chatbotSelfReferenceImageAsset: null },
      }),
    }),

    chatSetting("persona-drift", enabledToggle(
      (p) => p.chat.personaDriftEnabled,
      (v) => ({ chatbotPersonaDriftEnabled: v }),
    )),
    action("reset-persona-drift", {
      params: {},
      confirm: true,
      run: async ({ deps, request, text, path }) => {
        if (!deps.personaDriftStore) return { ok: false, message: text.message(path, "unavailable") };
        await deps.personaDriftStore.reset(request.guildId);
        return { ok: true, message: text.message(path, "done") };
      },
    }),
  ]),
]);
