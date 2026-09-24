import type { MutationSettingDefinition } from "./setting-definition.js";

export const djModeSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "dj-mode",
  description: "Lets music-controller roles control playback from anywhere.",
  configureOptions: () => [
    { type: "boolean", name: "enabled", description: "Whether DJ mode is on." },
  ],
  handle: (request, _deps, _previousProfile, input) => {
    const enabled = request.values.getBoolean("enabled");
    if (enabled !== null) input.djModeEnabled = enabled;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "DJ mode enabled", read: (p) => p.music.djModeEnabled },
  ],
};
