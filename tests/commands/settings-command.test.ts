import { describe, expect, it, vi } from "vitest";

import type { ControlChannelService } from "../../src/application/control-panel/control-channel-service.js";
import { SettingsCommand } from "../../src/infrastructure/discord/commands/setup/settings-command.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";

function profile(): GuildConfiguration {
  return {
    schemaVersion: 1,
    guildId: "123456789012345678",
    guildName: "Test Guild",
    displayName: "Test Bot",
    embedColor: "#3B82F6",
    idleImageUrl: null,
    idleImageAsset: null,
    features: {
      common: true,
      diagnostics: true,
      music: true,
      chatbot: false,
    },
    roles: {
      botAdministrator: new Set(["345678901234567890"]),
      musicController: new Set(["456789012345678901"]),
      restricted: new Set(["567890123456789012"]),
      chatbot: new Set(),
    },
    channels: {
      musicCommands: new Set(),
      controlPanel: "901234567890123456",
      auditLog: null,
      chatbot: new Set(),
    },
    music: {
      defaultVolume: 75,
      maximumVolume: 150,
      volumeButtonStep: 10,
      emptyQueueAction: "disconnect",
      emptyQueueDelayMs: 120_000,
      emptyChannelAction: "pause",
      emptyChannelGracePeriodMs: 30_000,
      resumeWhenOccupied: true,
    },
    chat: {
      personalityFile: null,
      personalityAsset: null,
      cooldownSeconds: 30,
      deniedMessage: "Denied",
      webSearchEnabled: false,
      imageInputEnabled: false,
      includeSources: true,
      maxImagesPerRequest: 2,
    },
    sourceFile: "test.yaml",
  };
}

describe("SettingsCommand", () => {
  it("rejects removing the last music-controller role while music is enabled", () => {
    const command = new SettingsCommand({} as never, {} as never);
    const validation = (
      command as unknown as {
        validateRoleGroupUpdate: (
          profile: GuildConfiguration,
          group: "musicController",
          nextRoleIds: ReadonlySet<string>,
        ) => string | null;
      }
    ).validateRoleGroupUpdate(profile(), "musicController", new Set());

    expect(validation).toContain("music-controller");
  });

  it("refreshes the panel immediately after idle-image settings change", async () => {
    const command = new SettingsCommand({} as never, {} as never);
    const refreshPanel = vi.fn().mockResolvedValue(undefined);
    const ensureGuildPanel = vi.fn().mockResolvedValue(undefined);
    command.bindControlChannelService({
      refreshPanel,
      ensureGuildPanel,
    } as unknown as ControlChannelService);

    await (
      command as unknown as {
        syncControlPanel: (
          guildId: string,
          subcommand: string,
          input: { idleImageAsset?: string },
          profile: GuildConfiguration,
        ) => Promise<void>;
      }
    ).syncControlPanel(
      profile().guildId,
      "panel",
      { idleImageAsset: "guild-assets/123456789012345678/idle.png" },
      profile(),
    );

    expect(refreshPanel).toHaveBeenCalledWith(profile().guildId, { forceIdleImage: true });
    expect(ensureGuildPanel).not.toHaveBeenCalled();
  });
});
