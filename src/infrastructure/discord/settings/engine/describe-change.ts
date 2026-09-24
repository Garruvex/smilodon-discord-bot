import type { SettingsText } from "../../../../application/i18n/settings/index.js";
import type { Texts } from "../../../../application/i18n/texts.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import { isListOption, optionPath } from "../registry/paths.js";
import type { SettingNode } from "../registry/types.js";
import type { SettingDeps } from "./request.js";
import { formatOptionValue, mention } from "./format-option-value.js";

// A setting's confirmation, derived from what actually changed: one
// "label: old → new" line per option whose value moved (lists as added /
// removed), plus the node's own extra lines and any notes from saving an
// upload. Shown to the admin and written
// to the audit log, in the guild's language.
export function describeSettingChange(
  node: SettingNode,
  path: string,
  previous: GuildConfiguration,
  updated: GuildConfiguration,
  text: SettingsText,
  ui: Texts["settings"],
  deps: SettingDeps,
  notes: readonly string[] = [],
): string {
  const lines: string[] = [];
  for (const [name, option] of Object.entries(node.options)) {
    const optionKey = optionPath(path, name);
    const label = text.label(optionKey);

    if (isListOption(option)) {
      const was = new Set(option.read(previous) ?? []);
      const now = new Set(option.read(updated) ?? []);
      const added = [...now].filter((id) => !was.has(id));
      const removed = [...was].filter((id) => !now.has(id));
      if (added.length === 0 && removed.length === 0) continue;
      const changes = [
        ...(added.length > 0 ? [ui.change.added({ items: added.map((id) => mention(option.kind, id)).join(", ") })] : []),
        ...(removed.length > 0 ? [ui.change.removed({ items: removed.map((id) => mention(option.kind, id)).join(", ") })] : []),
      ];
      lines.push(ui.change.list({ label, changes: changes.join("; ") }));
      continue;
    }

    const before = option.read(previous);
    const after = option.read(updated);
    if (before === after) continue;
    lines.push(ui.change.value({
      label,
      from: formatOptionValue(option, optionKey, before, text, ui),
      to: formatOptionValue(option, optionKey, after, text, ui),
    }));
  }

  const extra = [...(node.extraLines?.({ previous, updated, text, deps }) ?? []), ...notes];
  if (lines.length === 0 && extra.length === 0) return ui.noChanges;
  return [ui.updated, ...lines, ...extra].join("\n");
}
