import { describe, expect, it, vi } from "vitest";

import type { ControlChannelService } from "../../src/application/control-panel/control-channel-service.js";
import { SettingsUpdateService } from "../../src/application/settings/settings-update-service.js";
import type { UpdateGuildConfigurationInput } from "../../src/config/guild-configuration-provider.js";
import { actorUserId, guildId, memoryProvider } from "../helpers/settings-fixtures.js";

// Runs one write through SettingsUpdateService with a stub control panel.
async function applyWithPanel(input: UpdateGuildConfigurationInput): Promise<{
  refreshPanel: ReturnType<typeof vi.fn>;
  ensureGuildPanel: ReturnType<typeof vi.fn>;
}> {
  const refreshPanel = vi.fn().mockResolvedValue(undefined);
  const ensureGuildPanel = vi.fn().mockResolvedValue(undefined);
  const updater = new SettingsUpdateService(memoryProvider(), {} as never);
  updater.bindControlChannelService({ refreshPanel, ensureGuildPanel } as unknown as ControlChannelService);
  await updater.apply({ guildId, actorUserId, auditHeading: "test", input, describe: () => "" });
  return { refreshPanel, ensureGuildPanel };
}

describe("SettingsUpdateService", () => {
  it("refreshes the music panel right away after a new idle image is uploaded", async () => {
    const { refreshPanel, ensureGuildPanel } = await applyWithPanel({ idleImageAsset: `guild-assets/${guildId}/idle.png` });

    expect(refreshPanel).toHaveBeenCalledWith(guildId, { forceIdleImage: true, immediate: true });
    expect(ensureGuildPanel).not.toHaveBeenCalled();
  });

  it("refreshes the music panel right away after progress settings change", async () => {
    const { refreshPanel } = await applyWithPanel({ progressBarStyle: "none" });

    expect(refreshPanel).toHaveBeenCalledWith(guildId, { forceIdleImage: false, immediate: true });
  });

  it("refreshes the music panel right away so it switches language without waiting for playback", async () => {
    const { refreshPanel } = await applyWithPanel({ language: "ja" });

    expect(refreshPanel).toHaveBeenCalledWith(guildId, { immediate: true });
  });
});
