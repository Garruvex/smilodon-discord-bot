import { describe, expect, it } from "vitest";

import { languages } from "../../src/application/i18n/language.js";
import { settingsText } from "../../src/application/i18n/settings/index.js";
import { texts } from "../../src/application/i18n/texts.js";
import { settingsRegistry } from "../../src/infrastructure/discord/settings/groups/index.js";
import { controlIds, type ControlAction } from "../../src/infrastructure/discord/settings/panel/control-ids.js";
import { readNodeForm, renderNodeForm } from "../../src/infrastructure/discord/settings/panel/node-form.js";
import {
  maxCharacters,
  maxComponents,
  panelUnits,
  renderUnitMessages,
  type PanelMessage,
  type PanelUnit,
} from "../../src/infrastructure/discord/settings/panel/panel-messages.js";
import { registeredNodes, type RegisteredNode } from "../../src/infrastructure/discord/settings/registry/paths.js";
import { freshProfile } from "../helpers/settings-fixtures.js";

const adm = controlIds("adm");
const nodes = registeredNodes(settingsRegistry);
const nodeAt = (path: string): RegisteredNode => {
  const found = nodes.find((registered) => registered.path === path);
  if (!found) throw new Error(`No node at ${path}`);
  return found;
};

interface ComponentJson {
  type: number;
  custom_id?: string;
  content?: string;
  components?: ComponentJson[];
  accessory?: ComponentJson;
}

function flatten(component: ComponentJson): ComponentJson[] {
  const children = [...(component.components ?? []), ...(component.accessory ? [component.accessory] : [])];
  return [component, ...children.flatMap(flatten)];
}

function measure(message: PanelMessage): { components: number; characters: number; ids: string[] } {
  const all = message.payload.components.flatMap((container) => flatten(container.toJSON() as ComponentJson));
  return {
    components: all.length,
    characters: all.reduce((sum, component) => sum + (component.content?.length ?? 0), 0),
    ids: all.flatMap((component) => (component.custom_id ? [component.custom_id] : [])),
  };
}

function renderAll(language: (typeof languages)[number], units: readonly PanelUnit[] = panelUnits(nodes)): PanelMessage[] {
  const profile = freshProfile();
  return units.flatMap((unit) => renderUnitMessages(unit, {
    profile,
    text: settingsText(language),
    ui: texts[language],
    ids: adm,
    reports: new Map(),
  }));
}

// A fake submitted modal: text fields by name, and nothing else.
function formFields(values: Record<string, string>): never {
  return {
    getTextInputValue: (name: string) => {
      if (!(name in values)) throw new Error(`no field ${name}`);
      return values[name];
    },
  } as never;
}

describe("control ids", () => {
  const actions: ControlAction[] = [
    { kind: "refresh" },
    { kind: "toggle", path: "music.dj-mode", option: "enabled", value: true },
    { kind: "toggle", path: "music.dj-mode", option: "enabled", value: false },
    { kind: "choice", path: "music.lifecycle", option: "empty-queue-action" },
    { kind: "channel", path: "music.panel", option: "channel" },
    { kind: "role", path: "access.roles", option: "administrator" },
    { kind: "list", path: "community.link-fix", option: "channels" },
    { kind: "edit", path: "music.volume" },
    { kind: "form", path: "music.volume" },
    { kind: "run", path: "music.default-idle-image" },
    { kind: "confirm", path: "chat.persona.reset-persona-drift" },
  ];

  for (const prefix of ["adm", "wiz:3"]) {
    it(`round-trips every action under "${prefix}"`, () => {
      const ids = controlIds(prefix);
      for (const action of actions) expect(ids.parse(ids.encode(action))).toEqual(action);
    });
  }

  it("ignores ids under another prefix or with the wrong shape", () => {
    expect(adm.parse(controlIds("wiz:3").encode({ kind: "refresh" }))).toBeNull();
    expect(adm.parse("adm:t:music.dj-mode:enabled")).toBeNull();
    expect(adm.parse("adm:t:music.dj-mode:enabled:1:extra")).toBeNull();
    expect(adm.parse("adm:zz:music.dj-mode")).toBeNull();
    expect(adm.parse("admin:refresh")).toBeNull();
  });
});

describe("panel messages", () => {
  for (const language of languages) {
    it(`stay within Discord's limits in ${language}, with unique parseable ids`, () => {
      const messages = renderAll(language);
      const seen = new Set<string>();
      for (const message of messages) {
        const { components, characters, ids } = measure(message);
        expect(components, message.key).toBeLessThanOrEqual(maxComponents);
        expect(characters, message.key).toBeLessThanOrEqual(maxCharacters);
        for (const id of ids) {
          expect(id.length, id).toBeLessThanOrEqual(100);
          expect(adm.parse(id), id).not.toBeNull();
          expect(seen.has(id), `duplicate ${id}`).toBe(false);
          seen.add(id);
        }
      }
      expect(new Set(messages.map((message) => message.key)).size).toBe(messages.length);
    });
  }

  it("gives each toggle the value a click sets", () => {
    const [message] = renderAll("en", panelUnits([nodeAt("music.dj-mode")]));
    const { ids } = measure(message!);
    expect(ids).toContain(adm.encode({ kind: "toggle", path: "music.dj-mode", option: "enabled", value: true }));
  });

  it("continues a section that outgrows one message", () => {
    const many = Array.from({ length: 12 }, () => nodeAt("music.lifecycle"));
    const messages = renderAll("en", [{ key: "music", groupName: "music", sectionPath: null, nodes: many }]);

    expect(messages.length).toBeGreaterThan(1);
    expect(messages.map((message) => message.key)).toEqual(messages.map((_, index) => `music#${index}`));
    const heading = (message: PanelMessage): string =>
      (message.payload.components[0]!.toJSON() as ComponentJson).components![0]!.content!;
    expect(heading(messages[1]!)).toContain("(continued)");
    for (const message of messages) expect(measure(message).components).toBeLessThanOrEqual(maxComponents);
  });
});

describe("node forms", () => {
  const volume = nodeAt("music.volume");
  const text = settingsText("en");

  it("pre-fills the current values", () => {
    const profile = freshProfile();
    const modal = renderNodeForm(volume, profile, text, adm)!.toJSON();
    const inputs = modal.components.flatMap((label) => ("component" in label ? [label.component] : [])) as {
      custom_id: string;
      value?: string;
    }[];
    expect(inputs.find((input) => input.custom_id === "default")?.value).toBe(String(profile.music.defaultVolume));
  });

  it("passes on only the fields the admin changed", () => {
    const profile = freshProfile();
    const result = readNodeForm(volume, profile, text, texts.en, formFields({
      default: String(profile.music.defaultVolume),
      maximum: "120",
      "button-step": "",
    }));
    expect(result).toEqual({ ok: true, input: { scalars: { maximum: 120 }, files: {} } });
  });

  it("refuses a number that isn't one", () => {
    const result = readNodeForm(volume, freshProfile(), text, texts.en, formFields({ default: "loud" }));
    expect(result.ok).toBe(false);
  });

  it("has no form for a node with nothing to fill in", () => {
    expect(renderNodeForm(nodeAt("music.dj-mode"), freshProfile(), text, adm)).toBeNull();
  });
});
