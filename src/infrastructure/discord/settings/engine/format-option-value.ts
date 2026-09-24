import type { SettingsText } from "../../../../application/i18n/settings/index.js";
import type { Texts } from "../../../../application/i18n/texts.js";
import type { SettingOption } from "../registry/types.js";

export type OptionValue = string | number | boolean | readonly string[] | null;

// How a setting's value reads to an admin — the one formatter behind the
// admin panel's rows and every "label: old → new" confirmation, so the two
// can't describe the same value differently.
export function formatOptionValue(
  option: SettingOption,
  path: string,
  value: OptionValue,
  text: SettingsText,
  ui: Texts["settings"],
): string {
  if (value === null) return ui.value.notSet;
  switch (option.kind) {
    case "toggle":
      return value === true ? ui.value.on : ui.value.off;
    case "choice":
      return text.choice(path, String(value));
    case "channel":
      return `<#${String(value)}>`;
    case "role":
      return `<@&${String(value)}>`;
    case "channelList":
    case "roleList": {
      const ids = Array.isArray(value) ? (value as readonly string[]) : [];
      return ids.length === 0 ? ui.value.none : ids.map((id) => mention(option.kind, id)).join(", ");
    }
    case "upload":
      return ui.value.uploaded;
    case "integer":
    case "text":
      return String(value);
  }
}

export function mention(kind: "channelList" | "roleList", id: string): string {
  return kind === "channelList" ? `<#${id}>` : `<@&${id}>`;
}
