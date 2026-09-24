import type { SettingRequest } from "./setting-definition.js";
import type { UpdateGuildConfigurationInput } from "../../../../config/guild-configuration-provider.js";
import { MUSIC_LIMITS } from "../../../../config/guild-configuration-limits.js";
import type { MutationSettingDefinition } from "./setting-definition.js";

function assignNumber(
  request: SettingRequest,
  input: UpdateGuildConfigurationInput,
  option: string,
  field: "defaultVolume" | "maximumVolume" | "volumeButtonStep",
): void {
  const value = request.values.getInteger(option);
  if (value !== null) input[field] = value;
}

export const volumeSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "volume",
  description: "Updates music volume limits.",
  configureOptions: () => [
    {
      type: "integer", name: "default", description: "Default volume.",
      minValue: MUSIC_LIMITS.volumeDefault.min, maxValue: MUSIC_LIMITS.volumeDefault.max,
    },
    {
      type: "integer", name: "maximum", description: "Maximum volume.",
      minValue: MUSIC_LIMITS.volumeMaximum.min, maxValue: MUSIC_LIMITS.volumeMaximum.max,
    },
    {
      type: "integer", name: "button-step", description: "Panel adjustment amount.",
      minValue: MUSIC_LIMITS.volumeButtonStep.min, maxValue: MUSIC_LIMITS.volumeButtonStep.max,
    },
  ],
  handle: (request, _deps, _previousProfile, input) => {
    assignNumber(request, input, "default", "defaultVolume");
    assignNumber(request, input, "maximum", "maximumVolume");
    assignNumber(request, input, "button-step", "volumeButtonStep");
    return Promise.resolve({ ok: true });
  },
  fieldChanges: [
    { label: "Default volume", read: (p) => p.music.defaultVolume },
    { label: "Maximum volume", read: (p) => p.music.maximumVolume },
    { label: "Volume button step", read: (p) => p.music.volumeButtonStep },
  ],
};
