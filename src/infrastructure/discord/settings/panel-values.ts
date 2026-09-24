import type { SettingValues } from "./definitions/index.js";

export type PanelScalar = string | number | boolean;

// The admin panel's SettingValues: what a button, select or modal submitted,
// keyed by option name. Channels and roles are ids (handlers only read .id).
// Missing values behave like an omitted slash option — null, or a thrown
// error when the setting asked for it as required, matching discord.js.
export function panelValues(
  scalars: Readonly<Record<string, PanelScalar>>,
  lists: Readonly<Record<string, readonly string[]>> = {},
): SettingValues {
  const get = <T>(name: string, required: boolean | undefined, accept: (value: PanelScalar) => value is PanelScalar & T): T | null => {
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
    // The panel never uploads files — attachments stay slash-only.
    getAttachment: (name: string, required?: boolean): null => {
      if (required) throw new TypeError(`Required option "${name}" not found.`);
      return null;
    },
    getIdList: (name: string): readonly string[] | null => lists[name] ?? null,
  };
  return values as unknown as SettingValues;
}
