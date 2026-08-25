import type { MutationSettingDefinition } from "./setting-definition.js";

export const remindersSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "reminders",
  description: "Configures whether members can set personal reminders.",
  configureOptions: () => [
    { type: "boolean", name: "enabled", description: "Turn the /remind command on or off." },
  ],
  handle: (context, _deps, _previousProfile, input) => {
    const enabled = context.interaction.options.getBoolean("enabled");
    if (enabled !== null) input.remindersEnabled = enabled;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "Reminders enabled", read: (p) => p.features.reminders },
  ],
};
