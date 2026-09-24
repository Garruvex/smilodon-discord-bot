import { describe, expect, it } from "vitest";

import type { SettingsTextCatalogs } from "../../src/application/i18n/settings/index.js";
import { settingsText } from "../../src/application/i18n/settings/index.js";
import { texts } from "../../src/application/i18n/texts.js";
import { applyGuildConfigurationUpdate, createGuildConfigurationDocument, toGuildConfiguration } from "../../src/config/guild-configuration-document.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { UpdateGuildConfigurationInput } from "../../src/config/guild-configuration-provider.js";
import type { ParsedGuildConfigurationFile } from "../../src/config/guild-configuration-schema.js";
import { buildSlashCommandBuilder } from "../../src/infrastructure/discord/commands/command-metadata-builder.js";
import { describeSettingChange } from "../../src/infrastructure/discord/settings/engine/describe-change.js";
import { buildSettingPatch, type PatchResult } from "../../src/infrastructure/discord/settings/engine/setting-patch.js";
import { panelValues, type PanelScalar } from "../../src/infrastructure/discord/settings/panel-values.js";
import {
  choice,
  group,
  groupWithSections,
  integer,
  report,
  roleList,
  section,
  setting,
  toggle,
} from "../../src/infrastructure/discord/settings/registry/builders.js";
import type { SettingNode, SettingsGroup } from "../../src/infrastructure/discord/settings/registry/types.js";
import { registryProblems } from "../../src/infrastructure/discord/settings/registry/validate-registry.js";
import { buildSettingsCommandMetadata } from "../../src/infrastructure/discord/settings/slash/settings-slash-metadata.js";

function document(): ParsedGuildConfigurationFile {
  return createGuildConfigurationDocument({
    guildId: "123456789012345678",
    guildName: "Test Guild",
    displayName: "Test Bot",
    embedColor: "#3B82F6",
    idleImageUrl: null,
    botAdministratorRoleIds: ["200000000000000001"],
    musicControllerRoleIds: ["300000000000000001"],
    restrictedRoleIds: [],
    controlPanelChannelId: "500000000000000001",
  });
}

const profile = (): GuildConfiguration => toGuildConfiguration(document(), "test.yaml");

// The profile after a patch, through the real config update.
const applied = (patch: UpdateGuildConfigurationInput): GuildConfiguration =>
  toGuildConfiguration(applyGuildConfigurationUpdate(document(), patch), "test.yaml");

const djMode = setting("dj-mode", {
  enabled: toggle({ read: (p) => p.music.djModeEnabled, write: (v) => ({ djModeEnabled: v }) }),
}, { setup: true });

const lifecycle = setting("lifecycle", {
  "empty-queue-action": choice({
    choices: ["disconnect", "stay_connected"],
    read: (p) => p.music.emptyQueueAction,
    write: (v) => ({ emptyQueueAction: v }),
  }),
  "queue-delay-seconds": integer({
    min: 0,
    max: 600,
    read: (p) => p.music.emptyQueueDelayMs / 1000,
    write: (v) => ({ emptyQueueDelayMs: v * 1000 }),
  }),
});

const administrators = setting("administrators", {
  roles: roleList({
    read: (p) => [...p.roles.botAdministrator],
    write: (v) => ({ botAdministratorRoleIds: v }),
    validate: (v, context) => (v.length === 0 ? context.error("last-role") : null),
  }),
});

const fixture: readonly SettingsGroup[] = [
  group("music", [djMode, lifecycle, report("summary", () => Promise.resolve("Summary."))]),
  groupWithSections("access", [section("roles", [administrators])]),
];

const catalogs: SettingsTextCatalogs = {
  en: {
    "music": { title: "Music", description: "Music playback." },
    "music.dj-mode": { label: "DJ mode", description: "Control playback from anywhere." },
    "music.dj-mode.enabled": { label: "DJ mode", description: "Whether DJ mode is on." },
    "music.lifecycle": { label: "Leaving", description: "When the bot leaves." },
    "music.lifecycle.empty-queue-action": {
      label: "When the queue ends",
      description: "What happens when the queue ends.",
      choices: { "disconnect": "Disconnect", "stay_connected": "Stay connected" },
    },
    "music.lifecycle.queue-delay-seconds": { label: "Delay (seconds)", description: "How long to wait first." },
    "music.summary": { description: "Shows a summary." },
    "access": { title: "Access", description: "Who can do what." },
    "access.roles": { title: "Roles", description: "Access roles." },
    "access.roles.administrators": { label: "Administrators", description: "Bot administrator roles." },
    "access.roles.administrators.roles": {
      label: "Administrator roles",
      description: "Roles that can change settings.",
      errors: { "last-role": "Keep at least one administrator role." },
    },
  },
  "zh-TW": {},
  ja: {
    "music": { description: "音楽の再生。" },
    "music.lifecycle.empty-queue-action": { label: "キュー終了時", choices: { disconnect: "切断" } },
  },
};

const settingsUi = texts.en.settings;

function patchFor(node: SettingNode, path: string, scalars: Record<string, PanelScalar>, lists: Record<string, string[]> = {}): Promise<PatchResult> {
  return buildSettingPatch(node, panelValues(scalars, lists), {
    path,
    profile: profile(),
    text: settingsText("en", catalogs),
    ui: settingsUi,
    uploads: { guildId: profile().guildId, deps: {} as never },
  });
}

describe("settings registry validation", () => {
  it("accepts a registry whose English text is complete", () => {
    expect(registryProblems(fixture, catalogs)).toEqual([]);
  });

  it("reports missing English text, stale keys and over-long labels", () => {
    const broken: SettingsTextCatalogs = {
      ...catalogs,
      en: { ...catalogs.en, "music.dj-mode.enabled": { description: "Whether DJ mode is on." } },
      ja: { ...catalogs.ja, "music.gone": { description: "消えた設定。" }, "music.dj-mode": { label: "あ".repeat(46) } },
    };

    expect(registryProblems(fixture, broken)).toEqual([
      "English text is missing label for \"music.dj-mode.enabled\".",
      "ja settings text has \"music.gone\", which isn't registered.",
      "ja label for \"music.dj-mode\" must be 1-45 characters.",
    ]);
  });

  it("reports bad names, duplicates and oversized forms", () => {
    const sixNumbers = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`n${index}`, integer({
      min: 0, max: 1, read: () => 0, write: () => ({}),
    })]));
    const problems = registryProblems([
      group("music", [djMode, djMode, setting("Bad_Name", {}), setting("numbers", sixNumbers)]),
    ], catalogs);

    expect(problems).toContain("\"dj-mode\" is registered twice in group \"music\".");
    expect(problems).toContain("Setting \"Bad_Name\" must be 1-32 lowercase letters, digits or dashes.");
    expect(problems).toContain("music.numbers has 6 typed fields; an edit form holds 5.");
  });
});

describe("settings slash commands", () => {
  const music = buildSettingsCommandMetadata(fixture[0]!, catalogs);
  const access = buildSettingsCommandMetadata(fixture[1]!, catalogs);

  it("makes a flat group's nodes subcommands of /settings-<group>", () => {
    expect(music.name).toBe("settings-music");
    expect(music.subcommands?.map((subcommand) => subcommand.name)).toEqual(["dj-mode", "lifecycle", "summary"]);
    expect(music.subcommandGroups).toBeUndefined();
  });

  it("makes a section a subcommand group", () => {
    expect(access.subcommands).toBeUndefined();
    expect(access.subcommandGroups?.map((subcommandGroup) => [
      subcommandGroup.name,
      subcommandGroup.subcommands.map((subcommand) => subcommand.name),
    ])).toEqual([["roles", ["administrators"]]]);
  });

  it("derives option types, limits and translated text from the registry", () => {
    const lifecycleOptions = music.subcommands?.find((subcommand) => subcommand.name === "lifecycle")?.options;

    expect(music.descriptionLocalizations).toEqual({ ja: "音楽の再生。" });
    expect(lifecycleOptions).toEqual([
      {
        type: "string",
        name: "empty-queue-action",
        description: "What happens when the queue ends.",
        choices: [
          { name: "Disconnect", value: "disconnect", nameLocalizations: { ja: "切断" } },
          { name: "Stay connected", value: "stay_connected" },
        ],
      },
      { type: "integer", name: "queue-delay-seconds", description: "How long to wait first.", minValue: 0, maxValue: 600 },
    ]);
  });

  it("turns a list option into add/remove options", () => {
    const options = access.subcommandGroups?.[0]?.subcommands[0]?.options;
    expect(options).toEqual([
      { type: "role", name: "add", description: "Add to: Administrator roles" },
      { type: "role", name: "remove", description: "Remove from: Administrator roles" },
    ]);
  });

  it("builds commands Discord accepts, with embedded localizations", () => {
    const json = buildSlashCommandBuilder(music).toJSON();
    expect(json.description_localizations).toEqual({ ja: "音楽の再生。" });
    expect(() => buildSlashCommandBuilder(access).toJSON()).not.toThrow();
  });
});

describe("settings patches", () => {
  it("writes a toggle", async () => {
    expect(await patchFor(djMode, "music.dj-mode", { enabled: true })).toEqual({ kind: "patch", patch: { djModeEnabled: true } });
  });

  it("converts units through the option's own write", async () => {
    expect(await patchFor(lifecycle, "music.lifecycle", { "queue-delay-seconds": 30 }))
      .toEqual({ kind: "patch", patch: { emptyQueueDelayMs: 30_000 } });
  });

  it("refuses a value outside the option's limits", async () => {
    expect(await patchFor(lifecycle, "music.lifecycle", { "queue-delay-seconds": 601 }))
      .toEqual({ kind: "rejected", message: "Delay (seconds) must be between 0 and 600." });
    expect(await patchFor(lifecycle, "music.lifecycle", { "empty-queue-action": "explode" }))
      .toEqual({ kind: "rejected", message: "explode isn't one of the choices for When the queue ends." });
  });

  it("rebuilds a list from slash add/remove and from a whole panel selection alike", async () => {
    const viaSlash = await patchFor(administrators, "access.roles.administrators", { add: "200000000000000002" });
    const viaPanel = await patchFor(administrators, "access.roles.administrators", {}, {
      roles: ["200000000000000001", "200000000000000002"],
    });

    expect(viaSlash).toEqual({ kind: "patch", patch: { botAdministratorRoleIds: ["200000000000000001", "200000000000000002"] } });
    expect(viaPanel).toEqual(viaSlash);
  });

  it("runs the option's own validation, with its translated message", async () => {
    expect(await patchFor(administrators, "access.roles.administrators", { remove: "200000000000000001" }))
      .toEqual({ kind: "rejected", message: "Keep at least one administrator role." });
  });

  it("reports nothing to do when no option was given", async () => {
    expect(await patchFor(djMode, "music.dj-mode", {})).toEqual({ kind: "empty" });
  });
});

describe("settings confirmations", () => {
  const text = settingsText("en", catalogs);

  it("lists each changed option in the panel's formatting", () => {
    const before = profile();
    const after = applied({ djModeEnabled: true, emptyQueueAction: "stay_connected" });

    expect(describeSettingChange(djMode, "music.dj-mode", before, after, text, settingsUi))
      .toBe("Settings updated.\nDJ mode: Off → On");
    expect(describeSettingChange(lifecycle, "music.lifecycle", before, after, text, settingsUi))
      .toBe("Settings updated.\nWhen the queue ends: Disconnect → Stay connected");
  });

  it("shows list changes as added and removed", () => {
    const before = profile();
    const after = applied({ botAdministratorRoleIds: ["200000000000000002"] });

    expect(describeSettingChange(administrators, "access.roles.administrators", before, after, text, settingsUi)).toBe(
      "Settings updated.\nAdministrator roles: added <@&200000000000000002>; removed <@&200000000000000001>",
    );
  });

  it("says so when nothing changed", () => {
    expect(describeSettingChange(djMode, "music.dj-mode", profile(), profile(), text, settingsUi))
      .toBe("No changes — those settings already match.");
  });
});
