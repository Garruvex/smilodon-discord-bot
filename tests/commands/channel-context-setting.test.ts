import { describe, expect, it, vi } from "vitest";

import { contextScanAddSetting, contextStatusSetting } from "../../src/infrastructure/discord/commands/setup/settings/channel-context-setting.js";
import type { SettingDeps } from "../../src/infrastructure/discord/commands/setup/settings/setting-definition.js";
import type { CommandContext } from "../../src/application/commands/command.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { UpdateGuildConfigurationInput } from "../../src/config/guild-configuration-provider.js";
import type { ChannelSummaryCheckpoint, ChannelSummaryCheckpointStore } from "../../src/application/context/channel-summary-checkpoint-store.js";

function fakeContext(options: { channel?: { id: string } | null; seedDays?: number; restart?: boolean } = {}): CommandContext {
  return {
    interaction: {
      guildId: "guild",
      options: {
        getChannel: () => (options.channel === undefined ? { id: "channel" } : options.channel),
        getInteger: () => options.seedDays ?? null,
        getBoolean: () => options.restart ?? null,
      },
    },
  } as unknown as CommandContext;
}

function fakeProfile(
  contextScanChannelIds: readonly string[],
  contextDailyChannelIds: readonly string[] = [],
  chatbot = true,
): GuildConfiguration {
  return {
    guildId: "guild",
    features: { chatbot },
    chat: { contextScanChannelIds, contextDailyChannelIds, contextSeedDays: 7 },
  } as unknown as GuildConfiguration;
}

function fakeCheckpointStore(
  checkpoint: Partial<ChannelSummaryCheckpoint> | null,
): { store: ChannelSummaryCheckpointStore; resetScan: ReturnType<typeof vi.fn> } {
  const resetScan = vi.fn(() => Promise.resolve());
  const store: ChannelSummaryCheckpointStore = {
    initialize: () => Promise.resolve(),
    get: () => Promise.resolve(checkpoint as ChannelSummaryCheckpoint | null),
    recordSuccess: () => Promise.resolve(),
    recordError: () => Promise.resolve(),
    resetScan,
  };
  return { store, resetScan };
}

describe("contextScanAddSetting", () => {
  it("queues a brand-new channel", async () => {
    const deps: SettingDeps = { assets: {} as never, applicationEmojiCatalog: {} as never, channelSummaryProviderAvailable: true };
    const input: UpdateGuildConfigurationInput = {};

    const result = await contextScanAddSetting.handle(fakeContext(), deps, fakeProfile([]), input);

    expect(result).toEqual({ ok: true });
    expect(input.contextScanAddChannelId).toBe("channel");
  });

  it("rejects re-adding a channel whose scan is queued/in progress (not completed)", async () => {
    const deps: SettingDeps = {
      assets: {} as never, applicationEmojiCatalog: {} as never, channelSummaryProviderAvailable: true,
      channelSummaryCheckpointStore: fakeCheckpointStore({ scanCompletedAt: null, lastMessageId: "m1" }).store,
    };
    const input: UpdateGuildConfigurationInput = {};

    const result = await contextScanAddSetting.handle(fakeContext(), deps, fakeProfile(["channel"]), input);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("already queued or in progress");
  });

  it("rejects re-adding a completed scan without restart:true", async () => {
    const deps: SettingDeps = {
      assets: {} as never, applicationEmojiCatalog: {} as never, channelSummaryProviderAvailable: true,
      channelSummaryCheckpointStore: fakeCheckpointStore({ scanCompletedAt: 123 }).store,
    };
    const input: UpdateGuildConfigurationInput = {};

    const result = await contextScanAddSetting.handle(fakeContext(), deps, fakeProfile(["channel"]), input);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("restart:true");
  });

  it("resets scan checkpoint and re-queues when restart:true is passed for a completed scan", async () => {
    const { store: checkpointStore, resetScan } = fakeCheckpointStore({ scanCompletedAt: 123 });
    const deps: SettingDeps = {
      assets: {} as never, applicationEmojiCatalog: {} as never, channelSummaryProviderAvailable: true,
      channelSummaryCheckpointStore: checkpointStore,
    };
    const input: UpdateGuildConfigurationInput = {};

    const result = await contextScanAddSetting.handle(fakeContext({ restart: true }), deps, fakeProfile(["channel"]), input);

    expect(result).toEqual({ ok: true });
    expect(resetScan).toHaveBeenCalledWith("guild", "channel", expect.any(Number));
    expect(input.contextScanAddChannelId).toBe("channel");
  });

  it("rejects when no chat provider supports channel summarization", async () => {
    const deps: SettingDeps = { assets: {} as never, applicationEmojiCatalog: {} as never, channelSummaryProviderAvailable: false };
    const input: UpdateGuildConfigurationInput = {};

    const result = await contextScanAddSetting.handle(fakeContext(), deps, fakeProfile([]), input);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toContain("can't be queued");
  });

  it("describe distinguishes a fresh queue from a restart", () => {
    const updated = fakeProfile(["channel"]);
    const freshDescription = contextScanAddSetting.describe?.(fakeProfile([]), updated, { contextScanAddChannelId: "channel" });
    const restartDescription = contextScanAddSetting.describe?.(fakeProfile(["channel"]), updated, { contextScanAddChannelId: "channel" });

    expect(freshDescription).toContain("queued for a one-time history scan");
    expect(restartDescription).toContain("scan restarted");
  });
});

describe("contextStatusSetting", () => {
  it("reports provider availability, chatbot state, and per-channel scan/daily progress", async () => {
    const { store: checkpointStore } = fakeCheckpointStore({
      lastMessageId: "m5", scanCompletedAt: null, dailyCursor: null, dailyHighWaterMarkAt: null,
      lastRunAt: null, lastError: null, lastErrorCode: null, lastSuccessAt: 500,
    });
    const deps: SettingDeps = {
      assets: {} as never, applicationEmojiCatalog: {} as never,
      channelSummaryProviderAvailable: true, channelSummaryCheckpointStore: checkpointStore,
    };

    const output = await contextStatusSetting.run(
      fakeContext({ channel: null }), deps, fakeProfile(["channel"]),
    );

    expect(output).toContain("Provider: available");
    expect(output).toContain("Chatbot: enabled");
    expect(output).toContain("Scan: running");
    expect(output).toContain("Scan cursor: m5");
  });

  it("reports a paused chatbot and an unavailable provider", async () => {
    const deps: SettingDeps = { assets: {} as never, applicationEmojiCatalog: {} as never, channelSummaryProviderAvailable: false };

    const output = await contextStatusSetting.run(
      fakeContext({ channel: null }), deps, fakeProfile(["channel"], [], false),
    );

    expect(output).toContain("Provider: unavailable");
    expect(output).toContain("Chatbot: paused");
  });

  it("reports scan complete and daily failed with the actionable error code", async () => {
    const { store: checkpointStore } = fakeCheckpointStore({
      lastMessageId: "m9", scanCompletedAt: 1_000, dailyCursor: null, dailyHighWaterMarkAt: 1_000,
      lastRunAt: null, lastError: "The bot is missing Read Message History permission.", lastErrorCode: "missing_history_permission",
      lastSuccessAt: 1_000,
    });
    const deps: SettingDeps = {
      assets: {} as never, applicationEmojiCatalog: {} as never,
      channelSummaryProviderAvailable: true, channelSummaryCheckpointStore: checkpointStore,
    };

    const output = await contextStatusSetting.run(
      fakeContext({ channel: null }), deps, fakeProfile(["channel"], ["channel"]),
    );

    expect(output).toContain("Scan: complete");
    expect(output).toContain("Daily: failed");
    expect(output).toContain("missing_history_permission");
  });
});
