import type { CommandContext } from "../../../../../application/commands/command.js";
import type { CommandOptionMetadata } from "../../../../../application/commands/command-metadata.js";
import type { GuildConfiguration } from "../../../../../config/guild-configuration.js";
import type { UpdateGuildConfigurationInput } from "../../../../../config/guild-configuration-provider.js";
import type {
  MutationSettingDefinition,
  ReadOnlySettingDefinition,
  SettingDeps,
  SettingHandlerResult,
} from "./setting-definition.js";

function configureToolNameOption(description: string): readonly CommandOptionMetadata[] {
  return [{ type: "string", name: "name", description, required: true }];
}

// A plain string option rather than .addChoices(): choices must be known at
// command-definition build time, but the tool list is derived dynamically
// from CommandRegistry (see dependencies.ts) — a hardcoded choice list would
// silently drift out of sync as tools are added/removed. Validated here
// against the live registry instead; tools-list surfaces the current names.
function handleToolToggle(
  action: "enable" | "disable",
  context: CommandContext,
  deps: SettingDeps,
  previousProfile: GuildConfiguration,
  input: UpdateGuildConfigurationInput,
): SettingHandlerResult {
  const name = context.interaction.options.getString("name", true);
  const knownNames = new Set((deps.chatToolRegistry?.list() ?? []).map((tool) => tool.name));
  if (!knownNames.has(name)) {
    const available = [...knownNames].sort().join(", ") || "none registered";
    return { ok: false, message: `Unknown tool "${name}". Available tools: ${available}.` };
  }
  const disabled = new Set(previousProfile.chat.disabledTools);
  if (action === "enable") disabled.delete(name);
  else disabled.add(name);
  input.chatbotDisabledToolNames = [...disabled];
  return { ok: true };
}

function describeDisabledTools(_previous: GuildConfiguration, updated: GuildConfiguration): string {
  const disabled = [...updated.chat.disabledTools].sort();
  return `Disabled chat tools: ${disabled.length > 0 ? disabled.join(", ") : "none"}.`;
}

export const toolsEnableSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "tools-enable",
  description: "Re-enables a chat tool the model can call (see /setup settings chat tools-list).",
  configureOptions: () => configureToolNameOption("Tool name to enable."),
  handle: (context, deps, previousProfile, input) =>
    Promise.resolve(handleToolToggle("enable", context, deps, previousProfile, input)),
  describe: (previous, updated) => describeDisabledTools(previous, updated),
};

export const toolsDisableSetting: MutationSettingDefinition = {
  kind: "mutation",
  name: "tools-disable",
  description: "Disables a chat tool so the model can't call it (see /setup settings chat tools-list).",
  configureOptions: () => configureToolNameOption("Tool name to disable."),
  handle: (context, deps, previousProfile, input) =>
    Promise.resolve(handleToolToggle("disable", context, deps, previousProfile, input)),
  describe: (previous, updated) => describeDisabledTools(previous, updated),
};

// Descriptions are written for the model, not this listing, and keep
// growing as tools gain more nuance — left unbounded, enough registered
// tools push the whole message past Discord's 2000-char content limit and
// the command fails outright (see incident: read_link's description was the
// one that finally tipped it over). Truncating each one to a single
// scannable line keeps this listing's size bounded by tool *count* rather
// than by how verbose each description happens to be.
const maxDescriptionLength = 100;

function summarizeToolDescription(description: string): string {
  if (description.length <= maxDescriptionLength) return description;
  const truncated = description.slice(0, maxDescriptionLength);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, lastSpace > 0 ? lastSpace : maxDescriptionLength)}…`;
}

export const toolsListSetting: ReadOnlySettingDefinition = {
  kind: "readOnly",
  name: "tools-list",
  description: "Lists every chat tool the model can be given, and whether it's enabled here.",
  run: (_context, deps, profile) => {
    const tools = deps.chatToolRegistry?.list() ?? [];
    if (tools.length === 0) return Promise.resolve("No chat tools are registered.");
    const disabled = new Set(profile.chat.disabledTools);
    const lines = tools
      .map((tool) =>
        `${disabled.has(tool.name) ? "🔴" : "🟢"} **${tool.name}** — ${summarizeToolDescription(tool.description)}`)
      .join("\n");
    return Promise.resolve(`Chat tools (🟢 enabled, 🔴 disabled for this server):\n${lines}`);
  },
};
