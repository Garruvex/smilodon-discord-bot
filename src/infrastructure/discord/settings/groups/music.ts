import { isDeepStrictEqual } from "node:util";

import { MUSIC_LIMITS, PANEL_LIMITS } from "../../../../config/guild-configuration-limits.js";
import { action, channel, choice, group, integer, setting, text, toggle, upload } from "../registry/builders.js";
import { customProgressTheme, renderProgressPreview } from "./music-progress.js";

const seconds = (ms: number): number => Math.round(ms / 1000);

export const music = group("music", [
  setting("panel", {
    channel: channel({
      textOnly: true,
      read: (p) => p.channels.controlPanel,
      write: (v) => (v === null ? {} : { controlPanelChannelId: v }),
    }),
    "progress-style": choice({
      choices: ["standard", "yohta", "custom", "none"],
      read: (p) => p.panel.progressBar.style,
      write: (v) => ({ progressBarStyle: v }),
      validate: (v, context) => {
        const catalog = context.deps.applicationEmojiCatalog;
        if (v === "yohta" && !catalog.getYohtaTheme()) {
          return context.error("yohta-missing", { missing: catalog.getMissingYohtaEmojiNames().join(", ") });
        }
        if (v === "custom" && !context.profile.panel.progressBar.customTheme) return context.error("custom-missing");
        return null;
      },
    }),
    "progress-length": integer({
      min: PANEL_LIMITS.progressBarLength.min,
      max: PANEL_LIMITS.progressBarLength.max,
      read: (p) => p.panel.progressBar.length,
      write: (v) => ({ progressBarLength: v }),
    }),
  }, {
    extraLines: ({ previous, updated, text, deps }) =>
      isDeepStrictEqual(previous.panel.progressBar, updated.panel.progressBar)
        ? []
        : [`${text.message("music.panel", "preview")}\n${renderProgressPreview(updated.panel.progressBar, deps.applicationEmojiCatalog)}`],
  }),

  setting("idle-image", {
    file: upload({
      read: (p) => p.idleImageAsset,
      save: async (attachment, context) => ({
        patch: {
          idleImageAsset: await context.deps.assets.saveIdleImage(context.guildId, attachment),
          idleImageUrl: null,
        },
      }),
    }),
    url: text({
      maxLength: 500,
      read: (p) => p.idleImageUrl,
      write: (v) => ({ idleImageUrl: v.trim(), idleImageAsset: null }),
      validate: (v, context) => (/^https:\/\/\S+$/.test(v.trim()) ? null : context.error("not-https")),
    }),
  }),

  action("default-idle-image", {
    params: {},
    run: ({ text, path }) => Promise.resolve({
      ok: true,
      message: text.message(path, "done"),
      patch: { idleImageUrl: null, idleImageAsset: null },
    }),
  }),

  action("progress-emojis", {
    params: {
      completed: { kind: "text", maxLength: 100 },
      remaining: { kind: "text", maxLength: 100 },
      playing: { kind: "text", maxLength: 100 },
      paused: { kind: "text", maxLength: 100 },
      ending: { kind: "text", maxLength: 100 },
    },
    run: async ({ request, profile, text, path, values }) => {
      if (!request.guild) return { ok: false, message: text.message(path, "no-guild") };
      try {
        const theme = await customProgressTheme(request.guild, profile.panel.progressBar.customTheme, {
          completed: values.getString("completed"),
          remaining: values.getString("remaining"),
          playing: values.getString("playing"),
          paused: values.getString("paused"),
          ending: values.getString("ending"),
        });
        return {
          ok: true,
          message: text.message(path, "done"),
          patch: { progressBar: { ...profile.panel.progressBar, style: "custom", customTheme: theme } },
        };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  }),

  setting("volume", {
    default: integer({
      min: MUSIC_LIMITS.volumeDefault.min,
      max: MUSIC_LIMITS.volumeDefault.max,
      read: (p) => p.music.defaultVolume,
      write: (v) => ({ defaultVolume: v }),
    }),
    maximum: integer({
      min: MUSIC_LIMITS.volumeMaximum.min,
      max: MUSIC_LIMITS.volumeMaximum.max,
      read: (p) => p.music.maximumVolume,
      write: (v) => ({ maximumVolume: v }),
    }),
    "button-step": integer({
      min: MUSIC_LIMITS.volumeButtonStep.min,
      max: MUSIC_LIMITS.volumeButtonStep.max,
      read: (p) => p.music.volumeButtonStep,
      write: (v) => ({ volumeButtonStep: v }),
    }),
  }),

  setting("lifecycle", {
    "empty-queue-action": choice({
      choices: ["disconnect", "stay_connected"],
      read: (p) => p.music.emptyQueueAction,
      write: (v) => ({ emptyQueueAction: v }),
    }),
    "queue-delay-seconds": integer({
      min: seconds(MUSIC_LIMITS.emptyQueueDelayMs.min),
      max: seconds(MUSIC_LIMITS.emptyQueueDelayMs.max),
      read: (p) => seconds(p.music.emptyQueueDelayMs),
      write: (v) => ({ emptyQueueDelayMs: v * 1000 }),
    }),
    "empty-channel-action": choice({
      choices: ["continue", "pause", "disconnect"],
      read: (p) => p.music.emptyChannelAction,
      write: (v) => ({ emptyChannelAction: v }),
    }),
    "channel-grace-seconds": integer({
      min: seconds(MUSIC_LIMITS.emptyChannelGracePeriodMs.min),
      max: seconds(MUSIC_LIMITS.emptyChannelGracePeriodMs.max),
      read: (p) => seconds(p.music.emptyChannelGracePeriodMs),
      write: (v) => ({ emptyChannelGracePeriodMs: v * 1000 }),
    }),
    "resume-when-occupied": toggle({
      read: (p) => p.music.resumeWhenOccupied,
      write: (v) => ({ resumeWhenOccupied: v }),
    }),
  }, { setup: true }),

  setting("dj-mode", {
    enabled: toggle({ read: (p) => p.music.djModeEnabled, write: (v) => ({ djModeEnabled: v }) }),
  }, { setup: true }),

  setting("open-queue-requests", {
    enabled: toggle({ read: (p) => p.music.openQueueRequestsEnabled, write: (v) => ({ openQueueRequestsEnabled: v }) }),
  }, { setup: true }),

  setting("autoqueue-vote", {
    enabled: toggle({ read: (p) => p.music.autoQueueVoteEnabled, write: (v) => ({ autoQueueVoteEnabled: v }) }),
    "bar-style": choice({
      choices: ["squares", "thin"],
      read: (p) => p.music.autoQueueVoteBarStyle,
      write: (v) => ({ autoQueueVoteBarStyle: v }),
    }),
    options: integer({
      min: MUSIC_LIMITS.autoQueueVoteOptionCount.min,
      max: MUSIC_LIMITS.autoQueueVoteOptionCount.max,
      read: (p) => p.music.autoQueueVoteOptionCount,
      write: (v) => ({ autoQueueVoteOptionCount: v }),
    }),
  }, { setup: true }),
]);
