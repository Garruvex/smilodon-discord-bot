import type { MutationSettingDefinition } from "./setting-definition.js";

export const lifecycleSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "lifecycle",
  description: "Updates empty queue/channel behavior.",
  configureOptions: (b) => b
    .addStringOption((o) => o.setName("empty-queue-action").setDescription("Action when the queue ends.")
      .addChoices({ name: "Disconnect", value: "disconnect" }, { name: "Stay connected", value: "stay_connected" }))
    .addIntegerOption((o) => o.setName("queue-delay-seconds").setDescription("Delay before empty-queue action.").setMinValue(0).setMaxValue(86400))
    .addStringOption((o) => o.setName("empty-channel-action").setDescription("Action when everyone leaves.")
      .addChoices({ name: "Continue", value: "continue" }, { name: "Pause", value: "pause" }, { name: "Disconnect", value: "disconnect" }))
    .addIntegerOption((o) => o.setName("channel-grace-seconds").setDescription("Grace period before action.").setMinValue(0).setMaxValue(86400))
    .addBooleanOption((o) => o.setName("resume-when-occupied").setDescription("Resume after an automatic pause.")),
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
