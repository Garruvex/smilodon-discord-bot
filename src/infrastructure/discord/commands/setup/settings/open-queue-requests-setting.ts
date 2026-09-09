import type { MutationSettingDefinition } from "./setting-definition.js";

export const openQueueRequestsSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "open-queue-requests",
  description:
    "Lets any non-restricted member queue songs from the panel or /play without being in the bot's voice channel, " +
    "as long as it's already playing somewhere. Off by default to avoid abuse.",
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
