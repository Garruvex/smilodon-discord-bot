import { describe, expect, it } from "vitest";

import { settingsRegistry } from "../../src/infrastructure/discord/settings/groups/index.js";
import { resolveGuildEmoji } from "../../src/infrastructure/discord/settings/groups/music-progress.js";
import { panelValues, type PanelScalar } from "../../src/infrastructure/discord/settings/panel/panel-values.js";
import { registeredNodes } from "../../src/infrastructure/discord/settings/registry/paths.js";
import type { SettingOption } from "../../src/infrastructure/discord/settings/registry/types.js";
import { registryProblems } from "../../src/infrastructure/discord/settings/registry/validate-registry.js";
import { engineFixture, slashValues, stubEmojiCatalog } from "../helpers/settings-fixtures.js";

const settingNodes = registeredNodes(settingsRegistry).flatMap((registered) =>
  registered.node.kind === "setting" ? [{ path: registered.path, options: Object.entries(registered.node.options) }] : []);

// A value that stands in for the option on the panel.
function asInput(name: string, option: SettingOption, value: unknown): Parameters<typeof panelValues>[0] | null {
  if (value === null || option.kind === "upload") return null;
  if (option.kind === "channelList" || option.kind === "roleList") return { lists: { [name]: value as string[] } };
  return { scalars: { [name]: value as PanelScalar } };
}

describe("settings registry", () => {
  it("is valid, with complete English text and in-range translations", () => {
    expect(registryProblems(settingsRegistry)).toEqual([]);
  });

  // `read` must describe the current value in the option's own terms, or a
  // surface would show one thing and write another.
  describe("every option's read() matches its write()", () => {
    for (const { path, options } of settingNodes) {
      for (const [name, option] of options) {
        it(`${path}.${name}: writing the current value changes nothing`, async () => {
          const fixture = engineFixture();
          const input = asInput(name, option, option.read(fixture.profiles.current()));
          if (!input) return;

          const result = await fixture.run(path, panelValues(input));

          expect(result.kind === "updated" ? result.description : result).toBe("No changes — those settings already match.");
        });

        if (option.kind === "toggle" || option.kind === "choice") {
          it(`${path}.${name}: every value reads back after it's written`, async () => {
            const values: PanelScalar[] = option.kind === "toggle" ? [true, false] : [...option.choices];
            for (const value of values) {
              const fixture = engineFixture();
              const result = await fixture.run(path, panelValues({ scalars: { [name]: value } }));
              // A setting may refuse a value it can't use yet (custom
              // progress bar with no emojis, link fixing with no channels)
              // — but it must never accept one and store something else.
              if (result.kind === "rejected") continue;
              expect(option.read(fixture.profiles.current()), `${path}.${name}=${String(value)}`).toEqual(value);
            }
          });
        }
      }
    }
  });
});

describe("music settings", () => {
  it("confirms exactly what changed", async () => {
    const fixture = engineFixture();
    const result = await fixture.run("music.volume", slashValues({ default: 90 }));
    expect(result).toMatchObject({ kind: "updated", description: "Settings updated.\nDefault volume: 75 → 90" });
  });

  it("converts seconds to the stored milliseconds", async () => {
    const fixture = engineFixture();
    await fixture.run("music.lifecycle", slashValues({ "queue-delay-seconds": 30 }));
    expect(fixture.profiles.current().music.emptyQueueDelayMs).toBe(30_000);
  });

  it("refuses with the config's own reason when the whole config wouldn't be valid", async () => {
    const fixture = engineFixture();
    const result = await fixture.run("music.volume", slashValues({ default: 150, maximum: 100 }));
    expect(result).toEqual({
      kind: "rejected",
      message: "That change couldn't be saved: Default volume cannot exceed maximum volume.",
    });
  });

  it("refuses the Yohta progress bar when its emojis aren't provisioned", async () => {
    const fixture = engineFixture({ deps: { applicationEmojiCatalog: stubEmojiCatalog(true) } });
    const result = await fixture.run("music.panel", slashValues({ "progress-style": "yohta" }));
    expect(result).toEqual({
      kind: "rejected",
      message: "The Yohta preset is not provisioned for this bot application. Missing: progressed.",
    });
  });

  it("changes progress style and length together without one undoing the other", async () => {
    const fixture = engineFixture();
    await fixture.run("music.panel", slashValues({ "progress-style": "none", "progress-length": 14 }));
    expect(fixture.profiles.current().panel.progressBar).toMatchObject({ style: "none", length: 14 });
  });

  it("goes back to the default idle image", async () => {
    const fixture = engineFixture();
    await fixture.run("music.idle-image", slashValues({ url: "https://example.com/idle.png" }));
    const result = await fixture.run("music.default-idle-image", slashValues({}));

    expect(result).toMatchObject({ kind: "done", message: "The idle image is back to the bundled default." });
    expect(fixture.profiles.current().idleImageUrl).toBeNull();
  });

  it("resolves custom emojis by mention or by server name", () => {
    const emoji = { id: "111111111111111111", name: "yohta_run", guild: { id: "g" }, available: true, animated: true };
    const emojis = (): IterableIterator<never> => [emoji][Symbol.iterator]() as never;

    expect(resolveGuildEmoji("g", emojis(), "<a:yohta_run:111111111111111111>")).toMatchObject({ id: emoji.id, animated: true });
    expect(resolveGuildEmoji("g", emojis(), ":yohta_run:")).toMatchObject({ id: emoji.id });
    expect(() => resolveGuildEmoji("g", emojis(), "missing")).toThrow("was not found");
  });
});

describe("community settings", () => {
  it("won't turn birthdays on without an announcement channel", async () => {
    const fixture = engineFixture();
    const refused = await fixture.run("community.birthdays", slashValues({ enabled: true }));
    const accepted = await fixture.run("community.birthdays", slashValues({ enabled: true, channel: { id: "600000000000000001" } }));

    expect(refused).toEqual({ kind: "rejected", message: "Set a birthday announcement channel before turning this on." });
    expect(accepted.kind).toBe("updated");
  });

  it("applies several link-fix platform toggles at once", async () => {
    const fixture = engineFixture();
    await fixture.run("community.link-fix", slashValues({ twitter: false, reddit: false }));
    expect(fixture.profiles.current().linkFixPlatforms).toMatchObject({ twitter: false, reddit: false });
  });

  it("adds a watched channel the same way from slash and from the panel", async () => {
    const viaSlash = engineFixture();
    const viaPanel = engineFixture();
    await viaSlash.run("community.link-fix", slashValues({ "add-channels": { id: "600000000000000001" } }));
    await viaPanel.run("community.link-fix", panelValues({ lists: { channels: ["600000000000000001"] } }));

    expect([...viaSlash.profiles.current().channels.linkFix]).toEqual(["600000000000000001"]);
    expect(viaPanel.profiles.current().channels.linkFix).toEqual(viaSlash.profiles.current().channels.linkFix);
  });

  it("refuses an unknown time zone", async () => {
    const fixture = engineFixture();
    const result = await fixture.run("community.timezone", slashValues({ zone: "Mars/Olympus" }));
    expect(result).toEqual({
      kind: "rejected",
      message: "\"Mars/Olympus\" isn't a recognized IANA time zone name (e.g. \"America/New_York\").",
    });
  });

  it("names languages in their own language", async () => {
    const fixture = engineFixture();
    const result = await fixture.run("community.language", slashValues({ language: "ja" }));
    expect(result).toMatchObject({ description: "Settings updated.\nLanguage: English → 日本語" });
  });

  it("confirms in the guild's language", async () => {
    const fixture = engineFixture();
    const result = await fixture.run("music.dj-mode", slashValues({ enabled: true }), "zh-TW");
    expect(result).toMatchObject({ description: "設定已更新\nDJ 模式：關 → 開" });
  });

  it("clears a welcome channel", async () => {
    const fixture = engineFixture();
    await fixture.run("community.welcome", slashValues({ "leave-channel": { id: "600000000000000001" } }));
    await fixture.run("community.welcome", slashValues({ "clear-leave-channel": true }));
    expect(fixture.profiles.current().channels.leaveAnnouncements).toBeNull();
  });
});
