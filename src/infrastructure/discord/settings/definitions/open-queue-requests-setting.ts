import type { MutationSettingDefinition } from "./setting-definition.js";

export const openQueueRequestsSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "open-queue-requests",
  description: "Lets anyone queue songs without joining the bot's voice channel.",
  configureOptions: () => [
    { type: "boolean", name: "enabled", description: "Whether open queue requests are on." },
  ],
  handle: (request, _deps, _previousProfile, input) => {
    const enabled = request.values.getBoolean("enabled");
    if (enabled !== null) input.openQueueRequestsEnabled = enabled;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "Open queue requests enabled", read: (p) => p.music.openQueueRequestsEnabled },
  ],
};
