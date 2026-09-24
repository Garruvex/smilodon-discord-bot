import { MUSIC_LIMITS } from "../../../../../config/guild-configuration-limits.js";
import type { MutationSettingDefinition } from "./setting-definition.js";

export const autoQueueVoteSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "autoqueue-vote",
  description: "Lets listeners vote on which song autoqueue plays next.",
  configureOptions: () => [
    { type: "boolean", name: "enabled", description: "Whether listeners vote; off means autoqueue picks on its own." },
    {
      type: "string", name: "bar-style", description: "How vote bars look.",
      choices: [
        { name: "Colored squares", value: "squares" },
        { name: "Thin bar (matches the progress bar)", value: "thin" },
      ],
    },
    {
      type: "integer", name: "options", description: "How many songs to pick from.",
      minValue: MUSIC_LIMITS.autoQueueVoteOptionCount.min, maxValue: MUSIC_LIMITS.autoQueueVoteOptionCount.max,
    },
  ],
  handle: (context, _deps, _previousProfile, input) => {
    const enabled = context.interaction.options.getBoolean("enabled");
    const barStyle = context.interaction.options.getString("bar-style");
    const optionCount = context.interaction.options.getInteger("options");
    if (enabled !== null) input.autoQueueVoteEnabled = enabled;
    if (barStyle === "squares" || barStyle === "thin") input.autoQueueVoteBarStyle = barStyle;
    if (optionCount !== null) input.autoQueueVoteOptionCount = optionCount;
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "Autoqueue vote enabled", read: (p) => p.music.autoQueueVoteEnabled },
    { label: "Autoqueue vote bar style", read: (p) => p.music.autoQueueVoteBarStyle },
    { label: "Autoqueue vote options", read: (p) => p.music.autoQueueVoteOptionCount },
  ],
};
