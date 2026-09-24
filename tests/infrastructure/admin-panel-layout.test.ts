import { describe, expect, it } from "vitest";

import { createGuildConfigurationDocument, applyGuildConfigurationUpdate, toGuildConfiguration } from "../../src/config/guild-configuration-document.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";
import { guildConfigurationFileSchema, type ParsedGuildConfigurationFile } from "../../src/config/guild-configuration-schema.js";
import { buildDefinitionForGroup } from "../../src/infrastructure/discord/commands/setup/settings-command.js";
import type { MutationSettingDefinition, SettingGroup } from "../../src/infrastructure/discord/settings/definitions/index.js";
import { buildPanelLayout, type PanelOption, type PanelSettingRow } from "../../src/infrastructure/discord/settings/panel-layout.js";
import { panelValues, type PanelScalar } from "../../src/infrastructure/discord/settings/panel-values.js";
import { SettingsEngine } from "../../src/infrastructure/discord/settings/settings-engine.js";

const guildId = "123456789012345678";

// A provider backed by the real document update + schema validation, so a
// panel write round-trips exactly as it would against a stored config.
function memoryProvider(): GuildConfigurationProvider {
  let document: ParsedGuildConfigurationFile = createGuildConfigurationDocument({
    guildId,
    guildName: "Test Guild",
    displayName: "Test Bot",
    embedColor: "#3B82F6",
    idleImageUrl: null,
    botAdministratorRoleIds: ["234567890123456789"],
    musicControllerRoleIds: ["345678901234567890"],
    restrictedRoleIds: [],
    controlPanelChannelId: "567890123456789012",
  });
  const current = (): GuildConfiguration => toGuildConfiguration(document, "test.yaml");
  return {
    initialize: () => Promise.resolve(),
    find: current,
    require: current,
    getAll: () => [current()],
    create: () => Promise.resolve(current()),
    update: (_guildId, input): Promise<GuildConfiguration> => {
      document = guildConfigurationFileSchema.parse(applyGuildConfigurationUpdate(document, input));
      return Promise.resolve(current());
    },
    reload: () => Promise.resolve(),
  };
}

function engineWith(profiles: GuildConfigurationProvider): SettingsEngine {
  return new SettingsEngine({
    profiles,
    assets: {} as never,
    applicationEmojiCatalog: {
      getYohtaTheme: () => ({}),
      getMissingYohtaEmojiNames: () => [],
    } as never,
  });
}

async function runPanel(
  engine: SettingsEngine,
  row: PanelSettingRow,
  scalars: Record<string, PanelScalar>,
): ReturnType<SettingsEngine["run"]> {
  return engine.run(
    row.setting,
    { guildId, guild: null, actorUserId: "890123456789012345", values: panelValues(scalars) },
    { kind: "panel", section: row.groupName },
  );
}

function panelOptionsOf(row: PanelSettingRow): PanelOption[] {
  return [
    ...row.controls.flatMap((control) => (control.kind === "list" ? [] : [control.option])),
    ...row.modalFields,
  ];
}

const settingRows = buildPanelLayout().flatMap((section) =>
  section.rows.filter((row): row is PanelSettingRow => row.kind === "setting"));

describe("admin panel layout", () => {
  it("builds from the settings registry", () => {
    const music = buildPanelLayout().find((section) => section.name === "music");
    const rows = (music?.rows ?? []).filter((row): row is PanelSettingRow => row.kind === "setting");
    const summary = Object.fromEntries(rows.map((row) => [
      row.setting.name,
      {
        controls: row.controls.map((control) => `${control.kind}:${control.option.name}`),
        modal: row.modalFields.map((option) => option.name),
      },
    ]));

    expect(summary).toEqual({
      "panel": { controls: ["channel:channel", "choice:progress-style"], modal: ["progress-length"] },
      "volume": { controls: [], modal: ["default", "maximum", "button-step"] },
      "lifecycle": {
        controls: ["choice:empty-queue-action", "choice:empty-channel-action", "toggle:resume-when-occupied"],
        modal: ["queue-delay-seconds", "channel-grace-seconds"],
      },
      "dj-mode": { controls: ["toggle:enabled"], modal: [] },
      "open-queue-requests": { controls: ["toggle:enabled"], modal: [] },
      "autoqueue-vote": { controls: ["toggle:enabled", "choice:bar-style"], modal: ["options"] },
    });
  });

  // `read` must describe the current value in the option's own terms, or
  // the panel would show one thing and write another.
  describe("every panel option's read() matches its handler", () => {
    for (const row of settingRows) {
      for (const option of panelOptionsOf(row)) {
        const name = `${row.setting.name}:${option.name}`;

        it(`${name} — writing the current value changes nothing`, async () => {
          const profiles = memoryProvider();
          const current = option.panel.read(profiles.require(guildId));
          if (current === null) return;

          const result = await runPanel(engineWith(profiles), row, { [option.name]: current });

          expect(result.kind).toBe("updated");
          expect(result.kind === "updated" && result.description).toContain("No changes");
        });

        if (option.type === "boolean" || (option.type === "string" && option.choices)) {
          it(`${name} — every other value reads back after writing it`, async () => {
            const values: PanelScalar[] = option.type === "boolean"
              ? [true, false]
              : (option.choices ?? []).map((choice) => choice.value);
            for (const value of values) {
              const profiles = memoryProvider();
              const result = await runPanel(engineWith(profiles), row, { [option.name]: value });
              // A setting may refuse a value it can't use yet (a custom
              // progress bar with no emojis configured) — but it must not
              // accept it and store something else.
              if (result.kind === "rejected") continue;
              expect(option.panel.read(profiles.require(guildId)), `${name}=${String(value)}`).toBe(value);
            }
          });
        }
      }
    }
  });

  describe("registry checks", () => {
    const setting = (options: ReturnType<NonNullable<MutationSettingDefinition["configureOptions"]>>): MutationSettingDefinition => ({
      kind: "mutation",
      name: "example",
      description: "Example setting.",
      configureOptions: () => options,
      handle: () => Promise.resolve({ ok: true }),
    });
    const group = (example: MutationSettingDefinition, extra: Partial<SettingGroup> = {}): SettingGroup => ({
      name: "example",
      title: "Example",
      description: "Example group.",
      settings: [example],
      ...extra,
    });

    it("keeps panel-only list options and panel metadata out of the slash command", () => {
      const example = setting([
        { type: "boolean", name: "enabled", description: "On or off.", panel: { label: "Enabled", read: (): boolean => true } },
        { type: "channelList", name: "channels", description: "Channels.", panel: { label: "Channels", read: (): string[] => [] } },
      ]);
      const options = buildDefinitionForGroup(group(example)).subcommands?.[0]?.options ?? [];

      expect(options.map((option) => option.name)).toEqual(["enabled"]);
      expect(options[0]).not.toHaveProperty("panel");
    });

    it("rejects a section entry that isn't a setting in its group", () => {
      const example = setting([]);
      expect(() => buildPanelLayout([group(example, {
        panelSections: [{ name: "example", title: "Example", entries: [{ setting: "missing" }] }],
      })])).toThrow(/isn't a setting/);
    });

    it("rejects an attachment on the panel", () => {
      const example = setting([
        { type: "attachment", name: "file", description: "A file.", panel: { label: "File", read: (): null => null } },
      ]);
      expect(() => buildPanelLayout([group(example)])).toThrow(/can't be shown/);
    });

    it("rejects more modal fields than Discord allows", () => {
      const example = setting(Array.from({ length: 6 }, (_, index) => ({
        type: "integer" as const, name: `n${index}`, description: "A number.", panel: { label: "N", read: (): number => 1 },
      })));
      expect(() => buildPanelLayout([group(example)])).toThrow(/modal fields/);
    });

    it("gives every section a unique name", () => {
      const names = buildPanelLayout().map((section) => section.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });
});
