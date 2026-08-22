import { MUSIC_LIMITS } from "../../../../../config/guild-configuration-limits.js";
import type { MutationSettingDefinition } from "./setting-definition.js";

export const lifecycleSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "lifecycle",
  description: "Updates empty queue/channel behavior.",
  configureOptions: () => [
    {
      type: "string", name: "empty-queue-action", description: "Action when the queue ends.",
      choices: [{ name: "Disconnect", value: "disconnect" }, { name: "Stay connected", value: "stay_connected" }],
    },
    {
      type: "integer", name: "queue-delay-seconds", description: "Delay before empty-queue action.",
      minValue: MUSIC_LIMITS.emptyQueueDelayMs.min / 1000, maxValue: MUSIC_LIMITS.emptyQueueDelayMs.max / 1000,
    },
    {
      type: "string", name: "empty-channel-action", description: "Action when everyone leaves.",
      choices: [{ name: "Continue", value: "continue" }, { name: "Pause", value: "pause" }, { name: "Disconnect", value: "disconnect" }],
    },
    {
      type: "integer", name: "channel-grace-seconds", description: "Grace period before action.",
      minValue: MUSIC_LIMITS.emptyChannelGracePeriodMs.min / 1000, maxValue: MUSIC_LIMITS.emptyChannelGracePeriodMs.max / 1000,
    },
    { type: "boolean", name: "resume-when-occupied", description: "Resume after an automatic pause." },
  ],
  handle: (context, _deps, _previousProfile, input) => {
    const queueAction = context.interaction.options.getString("empty-queue-action");
    const channelAction = context.interaction.options.getString("empty-channel-action");
    const queueDelay = context.interaction.options.getInteger("queue-delay-seconds");
    const channelGrace = context.interaction.options.getInteger("channel-grace-seconds");
    const resume = context.interaction.options.getBoolean("resume-when-occupied");
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
