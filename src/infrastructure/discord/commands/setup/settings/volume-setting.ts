import type { CommandContext } from "../../../../../application/commands/command.js";
import type { UpdateGuildConfigurationInput } from "../../../../../config/guild-configuration-provider.js";
import type { MutationSettingDefinition } from "./setting-definition.js";

function assignNumber(
  context: CommandContext,
  input: UpdateGuildConfigurationInput,
  option: string,
  field: "defaultVolume" | "maximumVolume" | "volumeButtonStep",
): void {
  const value = context.interaction.options.getInteger(option);
  if (value !== null) input[field] = value;
}

export const volumeSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "volume",
  description: "Updates music volume limits.",
  configureOptions: (b) => b
    .addIntegerOption((o) => o.setName("default").setDescription("Default volume.").setMinValue(0).setMaxValue(1000))
    .addIntegerOption((o) => o.setName("maximum").setDescription("Maximum volume.").setMinValue(1).setMaxValue(1000))
    .addIntegerOption((o) => o.setName("button-step").setDescription("Panel adjustment amount.").setMinValue(1).setMaxValue(100)),
  handle: (context, _deps, _previousProfile, input) => {
    assignNumber(context, input, "default", "defaultVolume");
    assignNumber(context, input, "maximum", "maximumVolume");
    assignNumber(context, input, "button-step", "volumeButtonStep");
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "Default volume", read: (p) => p.music.defaultVolume },
    { label: "Maximum volume", read: (p) => p.music.maximumVolume },
    { label: "Volume button step", read: (p) => p.music.volumeButtonStep },
  ],
};
