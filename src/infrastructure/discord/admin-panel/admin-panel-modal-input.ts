import type { GuildConfiguration } from "../../../config/guild-configuration.js";
import type { PanelSettingRow } from "../settings/panel-layout.js";
import type { PanelScalar } from "../settings/panel-values.js";
import type { AdminPanelText } from "./admin-panel-text.js";

export type ModalInputResult =
  | { ok: true; scalars: Record<string, PanelScalar> }
  | { ok: false; message: string };

// Turns a submitted Edit modal into option values. Only fields the admin
// actually changed are passed on: a setting can have side effects for an
// option merely being present (a URL replacing an uploaded image), so an
// untouched pre-filled field must look exactly like an omitted slash
// option. A cleared field is treated as untouched too.
export function readAdminPanelModal(
  row: PanelSettingRow,
  profile: GuildConfiguration,
  text: AdminPanelText,
  submitted: (field: string) => string,
): ModalInputResult {
  const scalars: Record<string, PanelScalar> = {};
  for (const option of row.modalFields) {
    const raw = submitted(option.name).trim();
    if (raw === "") continue;
    const current = option.panel.read(profile);
    const field = text.label(option.panel.label);

    if (option.type === "integer") {
      if (!/^-?\d+$/.test(raw)) return { ok: false, message: text.ui.modal.notInteger({ field }) };
      const value = Number.parseInt(raw, 10);
      const min = option.minValue ?? Number.MIN_SAFE_INTEGER;
      const max = option.maxValue ?? Number.MAX_SAFE_INTEGER;
      if (value < min || value > max) {
        return { ok: false, message: text.ui.modal.outOfRange({ field, min, max }) };
      }
      if (value !== current) scalars[option.name] = value;
      continue;
    }

    if (option.type === "string") {
      if (option.maxLength !== undefined && raw.length > option.maxLength) {
        return { ok: false, message: text.ui.modal.tooLong({ field, max: option.maxLength }) };
      }
      if (raw !== current) scalars[option.name] = raw;
    }
  }
  return { ok: true, scalars };
}
