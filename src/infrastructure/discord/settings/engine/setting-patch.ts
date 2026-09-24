import type { Guild } from "discord.js";

import type { SettingsText } from "../../../../application/i18n/settings/index.js";
import type { Texts } from "../../../../application/i18n/texts.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import { clearSlashOptionName, listSlashOptionNames, optionPath } from "../registry/paths.js";
import type {
  ListOption,
  OptionContext,
  Patch,
  SettingNode,
  SettingOption,
  ValueOption,
} from "../registry/types.js";
import type { SettingDeps, SettingValues } from "./request.js";

export type PatchResult =
  | { kind: "patch"; patch: Patch; notes: readonly string[] }
  | { kind: "rejected"; message: string }
  | { kind: "empty" };

export interface PatchContext {
  path: string;
  guildId: string;
  guild: Guild | null;
  profile: GuildConfiguration;
  deps: SettingDeps;
  text: SettingsText;
  ui: Texts["settings"];
}

// Turns the values a surface collected (slash options, a panel control, a
// form) into one config patch for a setting node: each option that was
// given is range-checked, validated and written, then the node's own rule
// runs on the combined patch. Nothing is saved here — SettingsEngine does
// that — so this is the whole of a setting's "handler".
export async function buildSettingPatch(
  node: SettingNode,
  values: SettingValues,
  context: PatchContext,
): Promise<PatchResult> {
  let patch: Patch = {};
  const notes: string[] = [];
  let provided = false;
  const optionContext = (errorPath: string): OptionContext => ({
    profile: context.profile,
    deps: context.deps,
    guild: context.guild,
    error: (errorName, params) => context.text.message(errorPath, errorName, params),
  });

  for (const [name, option] of Object.entries(node.options)) {
    const path = optionPath(context.path, name);

    if (option.kind === "upload") {
      const attachment = values.getAttachment(name);
      if (!attachment) continue;
      provided = true;
      let saved: Awaited<ReturnType<typeof option.save>>;
      try {
        saved = await option.save(attachment, { guildId: context.guildId, deps: context.deps });
      } catch (error) {
        // The asset store explains what's wrong with a file (type, size).
        return { kind: "rejected", message: error instanceof Error ? error.message : String(error) };
      }
      patch = mergePatch(patch, saved.patch);
      notes.push(...(saved.notes ?? []));
      continue;
    }

    const given = givenValue(node, name, option, values, context.profile);
    if (!given) continue;
    provided = true;

    const error = checkRange(option, path, given.value, context) ?? given.validate(optionContext(path));
    if (error) return { kind: "rejected", message: error };
    patch = mergePatch(patch, given.write(context.profile));
  }

  if (!provided) return { kind: "empty" };

  const nodeError = node.validate?.(patch, optionContext(context.path));
  return nodeError ? { kind: "rejected", message: nodeError } : { kind: "patch", patch, notes };
}

// Later options win, except that map fields (per-platform link-fix
// overrides, per-channel memory modes) combine — several toggles can each
// write their own key of the same map.
export function mergePatch(base: Patch, next: Patch): Patch {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const previous = merged[key];
    merged[key] = isPlainObject(previous) && isPlainObject(value) ? { ...previous, ...value } : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// A value an option was given, paired with that option's own validate and
// write so each stays typed to its option kind.
interface GivenValue {
  value: unknown;
  validate(context: OptionContext): string | null;
  write(profile: GuildConfiguration): Patch;
}

function given<Value>(option: ValueOption<Value>, value: Value | undefined): GivenValue | null {
  if (value === undefined) return null;
  return {
    value,
    validate: (context) => option.validate?.(value, context) ?? null,
    write: (profile) => option.write(value, profile),
  };
}

// What an option was given, or null when it wasn't. A list is given either
// whole (the panel's multi-select) or as slash add/remove, which rebuild it
// from its current value. A clearable channel is cleared by an empty panel
// selection or the slash `clear` option.
function givenValue(
  node: SettingNode,
  name: string,
  option: Exclude<SettingOption, { kind: "upload" }>,
  values: SettingValues,
  profile: GuildConfiguration,
): GivenValue | null {
  switch (option.kind) {
    case "toggle":
      return given(option, values.getBoolean(name) ?? undefined);
    case "choice":
    case "text":
      return given(option, values.getString(name) ?? undefined);
    case "integer":
      return given(option, values.getInteger(name) ?? undefined);
    case "channel": {
      const id = values.getChannel(name)?.id;
      if (id !== undefined) return given(option, id);
      const cleared = values.getIdList?.(name)?.length === 0 || values.getBoolean(clearSlashOptionName(node, name)) === true;
      return option.clearable && cleared ? given(option, null) : null;
    }
    case "role":
      return given(option, values.getRole(name)?.id);
    case "channelList":
    case "roleList":
      return given(option, values.getIdList?.(name) ?? listFromAddRemove(node, name, option, values, profile));
  }
}

function listFromAddRemove(
  node: SettingNode,
  name: string,
  option: ListOption,
  values: SettingValues,
  profile: GuildConfiguration,
): readonly string[] | undefined {
  const names = listSlashOptionNames(node, name);
  const pick = (optionName: string): string | undefined => (option.kind === "channelList"
    ? values.getChannel(optionName)?.id
    : values.getRole(optionName)?.id);
  const add = pick(names.add);
  const remove = pick(names.remove);
  if (add === undefined && remove === undefined) return undefined;
  const next = new Set(option.read(profile) ?? []);
  if (add !== undefined) next.add(add);
  if (remove !== undefined) next.delete(remove);
  return [...next];
}

// Limits the slash command enforces itself, checked again for the panel's
// free-typed form fields and select values.
function checkRange(option: SettingOption, path: string, value: unknown, context: PatchContext): string | null {
  const label = context.text.label(path);
  switch (option.kind) {
    case "choice":
      return option.choices.includes(value as string)
        ? null
        : context.ui.error.notAChoice({ value: String(value), label });
    case "integer": {
      const number = value as number;
      return number >= option.min && number <= option.max
        ? null
        : context.ui.error.outOfRange({ label, min: option.min, max: option.max });
    }
    case "text":
      return (value as string).length <= option.maxLength
        ? null
        : context.ui.error.tooLong({ label, max: option.maxLength });
    default:
      return null;
  }
}
