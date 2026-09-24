import type { Attachment } from "discord.js";

import type { SettingValues } from "../engine/request.js";

export type PanelScalar = string | number | boolean;

export interface PanelInput {
  // Toggles, choices, typed values, and channel/role ids.
  scalars?: Readonly<Record<string, PanelScalar>>;
  // Whole lists from multi-selects (an empty one clears a clearable channel).
  lists?: Readonly<Record<string, readonly string[]>>;
  // Files from a form's upload field.
  files?: Readonly<Record<string, Attachment>>;
}

// SettingValues for the admin panel and guided setup: whatever a button,
// select or form submitted, keyed by option name. Channels and roles are
// ids (settings only read .id). A missing value behaves like an omitted
// slash option — null, or a thrown error when asked for as required,
// matching discord.js.
export function panelValues({ scalars = {}, lists = {}, files = {} }: PanelInput): SettingValues {
  const get = <T extends PanelScalar>(
    name: string,
    required: boolean | undefined,
    accept: (value: PanelScalar) => value is T,
  ): T | null => {
    const value = scalars[name];
    if (value !== undefined && accept(value)) return value;
    if (required) throw new TypeError(`Required option "${name}" not found.`);
    return null;
  };
  const isString = (value: PanelScalar): value is string => typeof value === "string";
  const idOf = (name: string, required?: boolean): { id: string } | null => {
    const id = get(name, required, isString);
    return id === null ? null : { id };
  };

  const values = {
    getBoolean: (name: string, required?: boolean): boolean | null =>
      get(name, required, (value): value is boolean => typeof value === "boolean"),
    getInteger: (name: string, required?: boolean): number | null =>
      get(name, required, (value): value is number => typeof value === "number" && Number.isInteger(value)),
    getString: (name: string, required?: boolean): string | null => get(name, required, isString),
    getChannel: idOf,
    getRole: idOf,
    getAttachment: (name: string, required?: boolean): Attachment | null => {
      const file = files[name];
      if (file) return file;
      if (required) throw new TypeError(`Required option "${name}" not found.`);
      return null;
    },
    getIdList: (name: string): readonly string[] | null => lists[name] ?? null,
  };
  return values as unknown as SettingValues;
}
