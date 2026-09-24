import { describe, expect, it } from "vitest";

import { languages } from "../../src/application/i18n/language.js";
import { createGuildConfigurationDocument, toGuildConfiguration } from "../../src/config/guild-configuration-document.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import { encodeAdminPanelId, parseAdminPanelId, type AdminPanelAction } from "../../src/infrastructure/discord/admin-panel/admin-panel-ids.js";
import { readAdminPanelModal } from "../../src/infrastructure/discord/admin-panel/admin-panel-modal-input.js";
import {
  renderAdminPanelHeader,
  renderAdminPanelModal,
  renderAdminPanelSection,
} from "../../src/infrastructure/discord/admin-panel/admin-panel-renderer.js";
import { summarizeChange } from "../../src/infrastructure/discord/admin-panel/admin-panel-service.js";
import { adminPanelText } from "../../src/infrastructure/discord/admin-panel/admin-panel-text.js";
import { buildPanelLayout, type PanelSettingRow } from "../../src/infrastructure/discord/settings/panel-layout.js";

function profile(): GuildConfiguration {
  return toGuildConfiguration(createGuildConfigurationDocument({
    guildId: "123456789012345678",
    guildName: "Test Guild",
    displayName: "Test Bot",
    embedColor: "#3B82F6",
    idleImageUrl: null,
    botAdministratorRoleIds: ["234567890123456789"],
    musicControllerRoleIds: ["345678901234567890"],
    restrictedRoleIds: [],
    controlPanelChannelId: "567890123456789012",
  }), "test.yaml");
}

// Discord counts every component in a message, nested ones included, and
// caps the total at 40; text displays share a 4000-character budget.
const componentLimit = 40;
const textLimit = 4000;
const customIdLimit = 100;

interface ComponentJson { type?: number; content?: string; custom_id?: string; value?: string; components?: unknown; component?: unknown; accessory?: unknown }

function walk(node: unknown, visit: (component: ComponentJson) => void): void {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (!node || typeof node !== "object") return;
  const component = node as ComponentJson;
  if (typeof component.type === "number") visit(component);
  walk(component.components, visit);
  // A modal label holds its input under `component`.
  walk(component.component, visit);
  walk(component.accessory, visit);
}

function measure(components: readonly { toJSON(): unknown }[]): { count: number; text: number; customIds: string[] } {
  let count = 0;
  let text = 0;
  const customIds: string[] = [];
  walk(components.map((component) => component.toJSON()), (component) => {
    count += 1;
    if (typeof component.content === "string") text += component.content.length;
    if (typeof component.custom_id === "string") customIds.push(component.custom_id);
  });
  return { count, text, customIds };
}

const layout = buildPanelLayout();

describe("admin panel rendering", () => {
  for (const language of languages) {
    const text = adminPanelText(language);

    for (const section of layout) {
      it(`fits Discord's message limits: ${section.name} (${language})`, () => {
        const { components } = renderAdminPanelSection({ section, profile: profile(), text, reports: new Map() });
        const { count, text: characters, customIds } = measure(components);

        expect(count).toBeLessThanOrEqual(componentLimit);
        expect(characters).toBeLessThanOrEqual(textLimit);
        expect(new Set(customIds).size).toBe(customIds.length);
        for (const customId of customIds) {
          expect(customId.length).toBeLessThanOrEqual(customIdLimit);
          expect(parseAdminPanelId(customId), customId).not.toBeNull();
        }
      });
    }

    it(`renders the header with a refresh control (${language})`, () => {
      const { components } = renderAdminPanelHeader({
        text,
        embedColor: "#3B82F6",
        lastChange: { summary: "DJ mode enabled: false → true", userId: "890123456789012345", at: new Date(0) },
        everyoneCanView: true,
      });
      const { customIds } = measure(components);
      expect(customIds).toEqual([encodeAdminPanelId({ kind: "refresh" })]);
    });
  }

  it("sets a toggle's button to the value a click switches to", () => {
    const music = layout.find((section) => section.name === "music")!;
    const { customIds } = measure(renderAdminPanelSection({
      section: music, profile: profile(), text: adminPanelText("en"), reports: new Map(),
    }).components);

    // DJ mode is off by default, so its button turns it on.
    expect(customIds).toContain("adm:t:dj-mode:enabled:1");
  });

  it("pre-fills an Edit modal with the current values", () => {
    const music = layout.find((section) => section.name === "music")!;
    const row = music.rows.find((candidate): candidate is PanelSettingRow =>
      candidate.kind === "setting" && candidate.setting.name === "volume")!;
    const modal = renderAdminPanelModal(music, row, profile(), adminPanelText("en")).toJSON();
    const inputs: { custom_id?: string; value?: string }[] = [];
    walk(modal.components, (component) => {
      if (component.type === 4) inputs.push(component);
    });

    expect(modal.custom_id).toBe("adm:m:music:volume");
    expect(inputs.map((input) => [input.custom_id, input.value])).toEqual([
      ["default", String(profile().music.defaultVolume)],
      ["maximum", String(profile().music.maximumVolume)],
      ["button-step", String(profile().music.volumeButtonStep)],
    ]);
  });
});

describe("admin panel ids", () => {
  const actions: AdminPanelAction[] = [
    { kind: "refresh" },
    { kind: "toggle", setting: "dj-mode", option: "enabled", value: true },
    { kind: "toggle", setting: "dj-mode", option: "enabled", value: false },
    { kind: "choice", setting: "lifecycle", option: "empty-queue-action" },
    { kind: "channel", setting: "panel", option: "channel" },
    { kind: "role", setting: "roles", option: "administrator" },
    { kind: "list", setting: "chatbot", option: "channels" },
    { kind: "edit", section: "music", setting: "volume" },
    { kind: "modal", section: "music", setting: "volume" },
  ];

  for (const action of actions) {
    it(`round-trips ${encodeAdminPanelId(action)}`, () => {
      expect(parseAdminPanelId(encodeAdminPanelId(action))).toEqual(action);
    });
  }

  it("rejects ids that aren't well-formed admin-panel ids", () => {
    for (const customId of ["poll:vote:1", "adm", "adm:x:dj-mode", "adm:t:dj-mode:enabled", "adm:t:dj-mode:enabled:2", "adm:e:music", "adm:refresh:extra"]) {
      expect(parseAdminPanelId(customId), customId).toBeNull();
    }
  });
});

describe("admin panel modal input", () => {
  const music = layout.find((section) => section.name === "music")!;
  const volume = music.rows.find((candidate): candidate is PanelSettingRow =>
    candidate.kind === "setting" && candidate.setting.name === "volume")!;
  const text = adminPanelText("en");
  const submit = (fields: Record<string, string>): ReturnType<typeof readAdminPanelModal> =>
    readAdminPanelModal(volume, profile(), text, (field) => fields[field] ?? "");

  it("passes on only the fields that changed", () => {
    const current = profile().music;
    expect(submit({
      "default": String(current.defaultVolume),
      "maximum": String(current.maximumVolume - 10),
      "button-step": "",
    })).toEqual({ ok: true, scalars: { maximum: current.maximumVolume - 10 } });
  });

  it("rejects a value that isn't a whole number", () => {
    const result = submit({ default: "7.5" });
    expect(result).toEqual({ ok: false, message: "Default volume must be a whole number." });
  });

  it("rejects a value outside the option's range", () => {
    const option = volume.modalFields.find((field) => field.name === "default")!;
    const max = option.type === "integer" ? option.maxValue! : 0;
    const result = submit({ default: String(max + 1) });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("between");
  });
});

describe("summarizeChange", () => {
  it("keeps the changed lines of an engine description", () => {
    expect(summarizeChange("Server settings updated.\nDJ mode enabled: false → true")).toBe("DJ mode enabled: false → true");
  });

  it("keeps a custom description as it is", () => {
    expect(summarizeChange("Panel settings updated. The control panel has been refreshed.")).toBe(
      "Panel settings updated. The control panel has been refreshed.",
    );
  });
});
