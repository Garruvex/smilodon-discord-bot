import type { MutationSettingDefinition } from "./setting-definition.js";

export const openQueueRequestsSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "open-queue-requests",
  description: "Lets anyone queue songs without joining the bot's voice channel, if it's already playing.",
  configureOptions: () => [
    { type: "boolean", name: "enabled", description: "Whether open queue requests are on." },
  ],
  handle: (context, _deps, _previousProfile, input) => {
    const enabled = context.interaction.options.getBoolean("enabled");
    if (enabled !== null) input.openQueueRequestsEnabled = enabled;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "Open queue requests enabled", read: (p) => p.music.openQueueRequestsEnabled },
  ],
};
