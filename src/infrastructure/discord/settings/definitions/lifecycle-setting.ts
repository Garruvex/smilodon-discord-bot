import { MUSIC_LIMITS } from "../../../../config/guild-configuration-limits.js";
import type { MutationSettingDefinition } from "./setting-definition.js";

export const lifecycleSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "lifecycle",
  description: "Updates empty queue/channel behavior.",
  configureOptions: () => [
    {
      type: "string", name: "empty-queue-action", description: "Action when the queue ends.",
      panel: { label: "When the queue ends", read: (p) => p.music.emptyQueueAction },
      choices: [{ name: "Disconnect", value: "disconnect" }, { name: "Stay connected", value: "stay_connected" }],
    },
    {
      type: "integer", name: "queue-delay-seconds", description: "Delay before empty-queue action.",
      panel: { label: "Queue-end delay (seconds)", read: (p) => p.music.emptyQueueDelayMs / 1000 },
      minValue: MUSIC_LIMITS.emptyQueueDelayMs.min / 1000, maxValue: MUSIC_LIMITS.emptyQueueDelayMs.max / 1000,
    },
    {
      type: "string", name: "empty-channel-action", description: "Action when everyone leaves.",
      panel: { label: "When everyone leaves", read: (p) => p.music.emptyChannelAction },
      choices: [{ name: "Continue", value: "continue" }, { name: "Pause", value: "pause" }, { name: "Disconnect", value: "disconnect" }],
    },
    {
      type: "integer", name: "channel-grace-seconds", description: "Grace period before action.",
      panel: { label: "Empty-channel grace (seconds)", read: (p) => p.music.emptyChannelGracePeriodMs / 1000 },
      minValue: MUSIC_LIMITS.emptyChannelGracePeriodMs.min / 1000, maxValue: MUSIC_LIMITS.emptyChannelGracePeriodMs.max / 1000,
    },
    { type: "boolean", name: "resume-when-occupied", description: "Resume after an automatic pause.", panel: { label: "Resume when someone returns", read: (p) => p.music.resumeWhenOccupied } },
  ],
  handle: (request, _deps, _previousProfile, input) => {
    const queueAction = request.values.getString("empty-queue-action");
    const channelAction = request.values.getString("empty-channel-action");
    const queueDelay = request.values.getInteger("queue-delay-seconds");
    const channelGrace = request.values.getInteger("channel-grace-seconds");
    const resume = request.values.getBoolean("resume-when-occupied");
    if (queueAction) input.emptyQueueAction = queueAction as "disconnect" | "stay_connected";
    if (channelAction) input.emptyChannelAction = channelAction as "continue" | "pause" | "disconnect";
    if (queueDelay !== null) input.emptyQueueDelayMs = queueDelay * 1000;
    if (channelGrace !== null) input.emptyChannelGracePeriodMs = channelGrace * 1000;
    if (resume !== null) input.resumeWhenOccupied = resume;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "Empty-queue action", read: (p) => p.music.emptyQueueAction },
    { label: "Empty-queue delay (ms)", read: (p) => p.music.emptyQueueDelayMs },
    { label: "Empty-channel action", read: (p) => p.music.emptyChannelAction },
    { label: "Empty-channel grace period (ms)", read: (p) => p.music.emptyChannelGracePeriodMs },
    { label: "Resume when occupied", read: (p) => p.music.resumeWhenOccupied },
  ],
};
