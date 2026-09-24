import type { Attachment } from "discord.js";

import type { SettingsText } from "../../../../application/i18n/settings/index.js";
import type { GuildConfiguration } from "../../../../config/guild-configuration.js";
import type { UpdateGuildConfigurationInput } from "../../../../config/guild-configuration-provider.js";
import type { SettingDeps, SettingRequest, SettingValues } from "../definitions/index.js";

// What one option contributes to a settings write. Options are pure: they
// describe a change, SettingsEngine applies it.
export type Patch = Partial<UpdateGuildConfigurationInput>;

// What an option's validate() sees. `error` returns a translated message
// from the option's `errors` text (see SettingsNodeText.errors).
export interface OptionContext {
  profile: GuildConfiguration;
  error(name: string, params?: Readonly<Record<string, string | number>>): string;
}

export interface ValueOption<Value> {
  // Must the slash option be given? Panel controls always carry a value.
  required?: boolean;
  // The current value in the option's own terms — what you'd pass to leave
  // things as they are (seconds rather than stored ms, a choice value, a
  // channel id). The panel shows it; confirmations diff it.
  read(profile: GuildConfiguration): Value | null;
  write(value: Value, profile: GuildConfiguration): Patch;
  // Refuse a value, with a message for the admin. Null means fine.
  validate?(value: Value, context: OptionContext): string | null;
}

export interface ToggleOption extends ValueOption<boolean> { kind: "toggle" }
// Generic over its values, so read/write see the literal union the config
// uses ("disconnect" | "stay_connected") rather than any string.
export interface ChoiceOption<Choice extends string = string> extends ValueOption<Choice> {
  kind: "choice";
  choices: readonly Choice[];
}
export interface IntegerOption extends ValueOption<number> { kind: "integer"; min: number; max: number }
export interface TextOption extends ValueOption<string> { kind: "text"; maxLength: number }
export interface ChannelOption extends ValueOption<string> { kind: "channel"; textOnly: boolean }
export interface RoleOption extends ValueOption<string> { kind: "role" }
// A list owns the whole list: the panel sends it whole (a multi-select),
// the slash surface derives add/remove options and rebuilds it from read().
// Either way the same validate and write run.
export interface ChannelListOption extends ValueOption<readonly string[]> { kind: "channelList"; textOnly: boolean }
export interface RoleListOption extends ValueOption<readonly string[]> { kind: "roleList" }

export interface UploadContext {
  guildId: string;
  deps: SettingDeps;
}

// A file, saved through the asset store. Slash-only: the panel can't
// upload, so an upload row points at its slash command instead.
export interface UploadOption {
  kind: "upload";
  required?: boolean;
  // What's stored now (an asset path), shown as uploaded / not set.
  read(profile: GuildConfiguration): string | null;
  save(attachment: Attachment, context: UploadContext): Promise<Patch>;
}

export type ListOption = ChannelListOption | RoleListOption;

export type SettingOption =
  | ToggleOption
  | ChoiceOption
  | IntegerOption
  | TextOption
  | ChannelOption
  | RoleOption
  | ListOption
  | UploadOption;

// Everything a node's own hooks see.
export interface NodeContext {
  request: SettingRequest;
  deps: SettingDeps;
  profile: GuildConfiguration;
  text: SettingsText;
  path: string;
}

// A set of options — the common case. Handler, confirmation, slash options
// and panel controls are all derived from `options`.
export interface SettingNode {
  kind: "setting";
  name: string;
  options: Readonly<Record<string, SettingOption>>;
  // Part of the guided /setup walkthrough.
  setup?: boolean;
  // A rule across options, checked on the combined patch.
  validate?(patch: Patch, context: OptionContext): string | null;
  // Extra confirmation lines for what a value diff can't show.
  extraLines?(previous: GuildConfiguration, updated: GuildConfiguration, text: SettingsText): readonly string[];
}

// An action's parameters: the same kinds as options, without read/write.
export type ActionParam =
  | Omit<ToggleOption, "read" | "write" | "validate">
  | Omit<ChoiceOption, "read" | "write" | "validate">
  | Omit<IntegerOption, "read" | "write" | "validate">
  | Omit<TextOption, "read" | "write" | "validate">
  | Omit<ChannelOption, "read" | "write" | "validate">
  | Omit<RoleOption, "read" | "write" | "validate">
  | Pick<UploadOption, "kind" | "required">;

export type ActionResult =
  | { ok: true; message: string; patch?: Patch }
  | { ok: false; message: string };

// Does something once (reset persona drift, queue a history scan, send a
// template). A `patch` it returns is saved and audited like any setting.
export interface ActionNode {
  kind: "action";
  name: string;
  params: Readonly<Record<string, ActionParam>>;
  setup?: boolean;
  // Ask before running from the panel.
  confirm?: boolean;
  run(context: NodeContext & { values: SettingValues }): Promise<ActionResult>;
}

// Read-only text (access summary, audit log, tools list).
export interface ReportNode {
  kind: "report";
  name: string;
  render(context: NodeContext): Promise<string>;
}

export type SettingsNode = SettingNode | ActionNode | ReportNode;

export interface SettingsSection {
  kind: "section";
  name: string;
  nodes: readonly SettingsNode[];
}

// A group registers either sections or nodes, never both. Its level decides
// the rest: `/settings-<group>`, a section becomes a subcommand group, a
// node a subcommand.
export type SettingsGroup =
  | { kind: "group"; name: string; sections: readonly SettingsSection[]; nodes?: undefined }
  | { kind: "group"; name: string; nodes: readonly SettingsNode[]; sections?: undefined };
