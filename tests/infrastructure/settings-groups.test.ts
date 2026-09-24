import { describe, expect, it, vi } from "vitest";

import type { ChatToolRegistry } from "../../src/application/chat/tools/chat-tool-registry.js";
import type { ChannelSummaryCheckpoint, ChannelSummaryCheckpointStore } from "../../src/application/context/channel-summary-checkpoint-store.js";
import { settingsRegistry } from "../../src/infrastructure/discord/settings/groups/index.js";
import { resolveGuildEmoji } from "../../src/infrastructure/discord/settings/groups/music-progress.js";
import { panelValues, type PanelScalar } from "../../src/infrastructure/discord/settings/panel/panel-values.js";
import { registeredNodes } from "../../src/infrastructure/discord/settings/registry/paths.js";
import type { SettingOption } from "../../src/infrastructure/discord/settings/registry/types.js";
import { registryProblems } from "../../src/infrastructure/discord/settings/registry/validate-registry.js";
import { engineFixture, guildId, slashValues, stubEmojiCatalog } from "../helpers/settings-fixtures.js";

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

describe("access settings", () => {
  const controller = "300000000000000001";

  it("won't remove the last music-controller role while music is on", async () => {
    const fixture = engineFixture();
    const result = await fixture.run("access.roles", slashValues({ "remove-music-controller": { id: controller } }));
    expect(result).toEqual({
      kind: "rejected",
      message: "Music is enabled, so at least one music-controller role must remain configured.",
    });
  });

  it("won't remove the last bot-administrator role", async () => {
    const fixture = engineFixture();
    const result = await fixture.run("access.roles", panelValues({ lists: { administrator: [] } }));
    expect(result).toMatchObject({ kind: "rejected", message: "At least one bot-administrator role must remain configured." });
  });

  it("adds a role the same way from slash and from the panel", async () => {
    const viaSlash = engineFixture();
    const viaPanel = engineFixture();
    await viaSlash.run("access.roles", slashValues({ "add-music-controller": { id: "300000000000000002" } }));
    await viaPanel.run("access.roles", panelValues({ lists: { "music-controller": [controller, "300000000000000002"] } }));

    expect([...viaSlash.profiles.current().roles.musicController]).toEqual([controller, "300000000000000002"]);
    expect(viaPanel.profiles.current().roles.musicController).toEqual(viaSlash.profiles.current().roles.musicController);
  });

  it("clears the audit log channel", async () => {
    const fixture = engineFixture();
    await fixture.run("access.audit-log", slashValues({ channel: { id: "600000000000000001" } }));
    await fixture.run("access.audit-log", slashValues({ clear: true }));
    expect(fixture.profiles.current().channels.auditLog).toBeNull();
  });

  it("summarizes who holds each access group", async () => {
    const result = await engineFixture().run("access.access", slashValues({}));
    expect(result).toMatchObject({ kind: "report", text: expect.stringContaining(`**Music controllers:** <@&${controller}>`) as string });
  });

  it("tells the admin to set a channel when audit logging isn't set up", async () => {
    const auditLogService = { fetchRecent: vi.fn().mockResolvedValue({ configured: false, entries: [] }) };
    const fixture = engineFixture({ deps: { auditLogService: auditLogService as never } });

    const result = await fixture.run("access.audit", slashValues({ count: 5 }));

    expect(auditLogService.fetchRecent).toHaveBeenCalledWith(expect.any(String), 5);
    expect(result).toMatchObject({ kind: "report", text: expect.stringContaining("No audit log channel is set") as string });
  });

  it("lists recent audit log entries on one line each", async () => {
    const auditLogService = {
      fetchRecent: vi.fn().mockResolvedValue({
        configured: true,
        entries: [{ description: "**<@1>**\n**/settings-music volume**\nDefault volume: 75 → 90", createdAt: 1_700_000_000_000 }],
      }),
    };
    const fixture = engineFixture({ deps: { auditLogService: auditLogService as never } });

    const result = await fixture.run("access.audit", slashValues({}));

    expect(auditLogService.fetchRecent).toHaveBeenCalledWith(expect.any(String), 10);
    expect(result).toEqual({
      kind: "report",
      text: "Recent audit log entries:\n<t:1700000000:R> **<@1>** · **/settings-music volume** · Default volume: 75 → 90",
    });
  });
});

describe("chat settings", () => {
  const channelId = "600000000000000001";
  const tools = (list: { name: string; description: string }[]): ChatToolRegistry =>
    ({ list: () => list }) as unknown as ChatToolRegistry;

  function checkpoints(checkpoint: Partial<ChannelSummaryCheckpoint> | null): {
    store: ChannelSummaryCheckpointStore;
    resetScan: ReturnType<typeof vi.fn>;
  } {
    const resetScan = vi.fn(() => Promise.resolve());
    return {
      resetScan,
      store: {
        initialize: () => Promise.resolve(),
        get: () => Promise.resolve(checkpoint as ChannelSummaryCheckpoint | null),
        recordSuccess: () => Promise.resolve(),
        recordError: () => Promise.resolve(),
        resetScan,
      },
    };
  }

  it("notes that a change has no effect while the chatbot is off", async () => {
    const fixture = engineFixture();
    const result = await fixture.run("chat.abilities.web-search", slashValues({ enabled: true }));
    expect(result).toMatchObject({ kind: "updated", description: expect.stringContaining("the chatbot is turned off") as string });
  });

  it("disables and re-enables a tool by name, checked against the live registry", async () => {
    const fixture = engineFixture({ deps: { chatToolRegistry: tools([{ name: "play_music", description: "Plays music." }]) } });

    const disabled = await fixture.run("chat.abilities.tool", slashValues({ name: "play_music", enabled: false }));
    expect(disabled).toMatchObject({ kind: "done", message: "Disabled chat tools: play_music." });
    expect(fixture.profiles.current().chat.disabledTools).toEqual(["play_music"]);

    await fixture.run("chat.abilities.tool", slashValues({ name: "play_music", enabled: true }));
    expect(fixture.profiles.current().chat.disabledTools).toEqual([]);
  });

  it("refuses an unknown tool and names the real ones", async () => {
    const fixture = engineFixture({ deps: { chatToolRegistry: tools([{ name: "play_music", description: "Plays music." }]) } });
    const result = await fixture.run("chat.abilities.tool", slashValues({ name: "nope", enabled: false }));
    expect(result).toEqual({ kind: "rejected", message: "Unknown tool \"nope\". Available tools: play_music." });
  });

  it("lists tools with their state, one short line each", async () => {
    const long = "A very long description that keeps going on and on to describe exactly what this tool does ".repeat(3);
    const fixture = engineFixture({
      deps: { chatToolRegistry: tools(Array.from({ length: 15 }, (_, index) => ({ name: `tool_${index}`, description: long }))) },
    });
    await fixture.run("chat.abilities.tool", slashValues({ name: "tool_1", enabled: false }));

    const result = await fixture.run("chat.abilities.tools", slashValues({}));

    const text = result.kind === "report" ? result.text : "";
    expect(text).toContain("🟢 **tool_0**");
    expect(text).toContain("🔴 **tool_1**");
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it("stores an uploaded self-reference image, and removing it deletes the file", async () => {
    const saved = `guild-assets/${guildId}/self-reference.png`;
    const assets = {
      saveSelfReferenceImage: vi.fn(() => Promise.resolve(saved)),
      removeSelfReferenceImage: vi.fn(() => Promise.resolve()),
    };
    const fixture = engineFixture({ deps: { assets: assets as never } });

    await fixture.run("chat.persona.self-reference-image", slashValues({ image: { id: "attachment" } }));
    expect(fixture.profiles.current().chat.selfReferenceImageAsset).toBe(saved);

    const removed = await fixture.run("chat.persona.remove-self-reference-image", slashValues({}));
    expect(removed).toMatchObject({ kind: "done", message: "Self-reference image removed." });
    expect(fixture.profiles.current().chat.selfReferenceImageAsset).toBeNull();
    expect(assets.removeSelfReferenceImage).toHaveBeenCalledWith(saved);
  });

  it("sets a channel's memory mode", async () => {
    const fixture = engineFixture();
    const result = await fixture.run("chat.memory.memory-mode", slashValues({ channel: { id: channelId }, mode: "isolated" }));

    expect(result).toMatchObject({
      kind: "done",
      message: `<#${channelId}> memory mode set to Isolated — memory stays in this channel.`,
    });
    expect(fixture.profiles.current().chat.channelMemoryModes[channelId]).toBe("isolated");
  });

  describe("history scans", () => {
    it("won't queue anything without a provider that can summarize", async () => {
      const fixture = engineFixture({ deps: { channelSummaryProviderAvailable: false } });
      const scan = await fixture.run("chat.memory.context-scan", slashValues({ channel: { id: channelId } }));
      const daily = await fixture.run("chat.memory.context-daily", slashValues({ add: { id: channelId } }));

      expect(scan).toMatchObject({ kind: "rejected", message: expect.stringContaining("can't be queued") as string });
      expect(daily).toMatchObject({ kind: "rejected", message: expect.stringContaining("can't be turned on") as string });
    });

    it("queues a new channel, noting the chatbot is off", async () => {
      const fixture = engineFixture({ deps: { channelSummaryProviderAvailable: true } });
      const result = await fixture.run("chat.memory.context-scan", slashValues({ channel: { id: channelId }, "seed-days": 14 }));

      expect(result).toMatchObject({ kind: "done", message: expect.stringContaining("queued for a one-time history scan") as string });
      expect(result).toMatchObject({ message: expect.stringContaining("the chatbot is turned off") as string });
      expect(fixture.profiles.current().chat).toMatchObject({ contextScanChannelIds: [channelId], contextSeedDays: 14 });
    });

    it("reports a scan that's still running instead of queueing it again", async () => {
      const fixture = engineFixture({
        deps: { channelSummaryProviderAvailable: true, channelSummaryCheckpointStore: checkpoints({ lastMessageId: "m1" }).store },
      });
      await fixture.run("chat.memory.context-scan", slashValues({ channel: { id: channelId } }));
      const again = await fixture.run("chat.memory.context-scan", slashValues({ channel: { id: channelId } }));

      expect(again).toMatchObject({ kind: "rejected", message: expect.stringContaining("already queued or running") as string });
    });

    it("re-runs a finished scan only when asked to restart", async () => {
      const { store, resetScan } = checkpoints({ scanCompletedAt: 123 });
      const fixture = engineFixture({ deps: { channelSummaryProviderAvailable: true, channelSummaryCheckpointStore: store } });
      await fixture.run("chat.memory.context-scan", slashValues({ channel: { id: channelId } }));

      const refused = await fixture.run("chat.memory.context-scan", slashValues({ channel: { id: channelId } }));
      const restarted = await fixture.run("chat.memory.context-scan", slashValues({ channel: { id: channelId }, restart: true }));

      expect(refused).toMatchObject({ kind: "rejected", message: expect.stringContaining("already finished") as string });
      expect(restarted).toMatchObject({ kind: "done", message: expect.stringContaining("scan restarted") as string });
      expect(resetScan).toHaveBeenCalledWith(guildId, channelId, expect.any(Number));
    });

    it("stops summarizing a channel on both lists", async () => {
      const fixture = engineFixture({ deps: { channelSummaryProviderAvailable: true } });
      await fixture.run("chat.memory.context-scan", slashValues({ channel: { id: channelId } }));
      await fixture.run("chat.memory.context-daily", slashValues({ add: { id: channelId } }));

      await fixture.run("chat.memory.context-remove", slashValues({ channel: { id: channelId } }));

      expect(fixture.profiles.current().chat).toMatchObject({ contextScanChannelIds: [], contextDailyChannelIds: [] });
    });

    it("reports each channel's scan and daily state", async () => {
      const { store } = checkpoints({
        lastMessageId: "m9", scanCompletedAt: 1_000, dailyCursor: null, dailyHighWaterMarkAt: 1_000,
        lastError: "Missing Read Message History.", lastErrorCode: "missing_history_permission", lastSuccessAt: 1_000,
      });
      const fixture = engineFixture({ deps: { channelSummaryProviderAvailable: true, channelSummaryCheckpointStore: store } });
      await fixture.run("chat.memory.context-scan", slashValues({ channel: { id: channelId } }));
      await fixture.run("chat.memory.context-daily", slashValues({ add: { id: channelId } }));

      const result = await fixture.run("chat.memory.context-status", slashValues({}));

      const text = result.kind === "report" ? result.text : "";
      expect(text).toContain("Provider: available");
      expect(text).toContain("Chatbot: off");
      expect(text).toContain("Scan: complete");
      expect(text).toContain("Daily: failed");
      expect(text).toContain("missing_history_permission");
    });
  });

  it("sends a starter file to edit", async () => {
    const result = await engineFixture().run("chat.persona.template", slashValues({ kind: "examples" }));

    expect(result).toMatchObject({
      kind: "done",
      message: expect.stringContaining("/settings-chat persona examples file:<file>") as string,
    });
    const files = result.kind === "done" ? result.files : [];
    expect(files.map((file) => file.name)).toEqual(["examples.md"]);
  });
});
