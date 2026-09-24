import type { SettingsText } from "../../../../application/i18n/settings/index.js";
import type { Texts } from "../../../../application/i18n/texts.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import type { SettingValues } from "../definitions/index.js";
import { listSlashOptionNames, optionPath } from "../registry/paths.js";
import type {
  ListOption,
  OptionContext,
  Patch,
  SettingNode,
  SettingOption,
  UploadContext,
  ValueOption,
} from "../registry/types.js";

export type PatchResult =
  | { kind: "patch"; patch: Patch }
  | { kind: "rejected"; message: string }
  | { kind: "empty" };

export interface PatchContext {
  path: string;
  profile: GuildConfiguration;
  text: SettingsText;
  ui: Texts["settings"];
  uploads: UploadContext;
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
  let provided = false;

  for (const [name, option] of Object.entries(node.options)) {
    const path = optionPath(context.path, name);
    const optionContext: OptionContext = {
      profile: context.profile,
      error: (errorName, params) => context.text.error(path, errorName, params),
    };

    if (option.kind === "upload") {
      const attachment = values.getAttachment(name);
      if (!attachment) continue;
      provided = true;
      patch = { ...patch, ...await option.save(attachment, context.uploads) };
      continue;
    }

    const given = givenValue(node, name, option, values, context.profile);
    if (!given) continue;
    provided = true;

    const error = checkRange(option, path, given.value, context) ?? given.validate(optionContext);
    if (error) return { kind: "rejected", message: error };
    patch = { ...patch, ...given.write(context.profile) };
  }

  if (!provided) return { kind: "empty" };

  const nodeError = node.validate?.(patch, {
    profile: context.profile,
    error: (errorName, params) => context.text.error(context.path, errorName, params),
  });
  return nodeError ? { kind: "rejected", message: nodeError } : { kind: "patch", patch };
}

// A value an option was given, paired with that option's own validate and
// write so each stays typed to its option kind.
interface GivenValue {
  value: unknown;
  validate(context: OptionContext): string | null;
  write(profile: GuildConfiguration): Patch;
}

function given<Value>(option: ValueOption<Value>, value: Value | null | undefined): GivenValue | null {
  if (value === null || value === undefined) return null;
  return {
    value,
    validate: (context) => option.validate?.(value, context) ?? null,
    write: (profile) => option.write(value, profile),
  };
}

// What an option was given, or null when it wasn't. A list option is given
// either whole (the panel's multi-select) or as slash add/remove, which
// rebuild the list from its current value.
function givenValue(
  node: SettingNode,
  name: string,
  option: Exclude<SettingOption, { kind: "upload" }>,
  values: SettingValues,
  profile: GuildConfiguration,
): GivenValue | null {
  switch (option.kind) {
    case "toggle":
      return given(option, values.getBoolean(name));
    case "choice":
    case "text":
      return given(option, values.getString(name));
    case "integer":
      return given(option, values.getInteger(name));
    case "channel":
      return given(option, values.getChannel(name)?.id);
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
