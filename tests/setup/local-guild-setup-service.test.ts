import { type Guild, type GuildMember, type TextChannel } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { LocalGuildSetupService } from "../../src/application/setup/local-guild-setup-service.js";
import type { ControlChannelService } from "../../src/application/control-panel/control-channel-service.js";
import type { GuildCommandDeploymentService } from "../../src/application/commands/guild-command-deployment-service.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";

const guildId = "123456789012345678";
const channelId = "234567890123456789";

function profile(): GuildConfiguration {
  return {
    schemaVersion: 1,
    guildId,
    guildName: "Test Guild",
    displayName: "Test Bot",
    embedColor: "#3B82F6",
    idleImageUrl: null,
    idleImageAsset: null,
    features: { common: true, diagnostics: true, music: true, chatbot: false },
    roles: {
      botAdministrator: new Set(["345678901234567890"]),
      musicController: new Set(["456789012345678901"]),
      restricted: new Set(["567890123456789012"]),
      chatbot: new Set(),
    },
    channels: {
      musicCommands: new Set(),
      controlPanel: channelId,
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

describe("LocalGuildSetupService", () => {
  it("resumes an existing profile without creating duplicate Discord resources", async () => {
    const configuredProfile = profile();
    const editPermissions = vi.fn().mockResolvedValue(undefined);
    const controlChannel = {
      id: channelId,
      type: 0,
      guild: { roles: { everyone: { id: guildId } } },
      permissionOverwrites: { edit: editPermissions },
    } as unknown as TextChannel;
    const createRole = vi.fn();
    const guild = {
      id: guildId,
      channels: { fetch: vi.fn().mockResolvedValue(controlChannel) },
      roles: { everyone: { id: guildId }, create: createRole },
    } as unknown as Guild;
    const provider = {
      find: vi.fn().mockReturnValue(configuredProfile),
    } as unknown as GuildConfigurationProvider;
    const deploy = vi.fn().mockResolvedValue(12);
    const deployment = { deploy } as unknown as GuildCommandDeploymentService;
    const ensureGuildPanel = vi.fn().mockResolvedValue(undefined);
    const panels = { ensureGuildPanel } as unknown as ControlChannelService;
    const logger = { info: vi.fn() } as unknown as Logger;
    const service = new LocalGuildSetupService(provider, deployment, panels, logger);

    const result = await service.initialize({
      guild,
      initializedBy: {} as GuildMember,
      displayName: "Ignored while resuming",
      idleImageUrl: null,
      controlChannel: null,
      botAdministratorRole: null,
      musicControllerRole: null,
      restrictedRole: null,
    });

    expect(ensureGuildPanel).toHaveBeenCalledWith(guildId);
    expect(deploy).toHaveBeenCalledWith(configuredProfile);
    expect(result.guildId).toBe(guildId);
    expect(result.controlChannelId).toBe(channelId);
    expect(result.deployedCommandCount).toBe(12);
    expect(createRole).not.toHaveBeenCalled();
  });

  it("grants bot administrator and music controller roles during first-time setup", async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const botAdministratorRole = { id: "345678901234567890" };
    const musicControllerRole = { id: "456789012345678901" };
    const restrictedRole = { id: "567890123456789012" };
    const controlChannel = {
      id: channelId,
      type: 0,
      guild: { roles: { everyone: { id: guildId } } },
      permissionOverwrites: { edit: vi.fn().mockResolvedValue(undefined) },
    };
    const createRole = vi
      .fn()
      .mockResolvedValueOnce(botAdministratorRole)
      .mockResolvedValueOnce(musicControllerRole)
      .mockResolvedValueOnce(restrictedRole);
    const guild = {
      id: guildId,
      name: "Test Guild",
      channels: {
        create: vi.fn().mockResolvedValue(controlChannel),
        fetch: vi.fn().mockResolvedValue(controlChannel),
      },
      roles: { create: createRole },
      members: {
        me: {
          permissions: {
            has: () => true,
          },
        },
      },
    } as unknown as Guild;
    const provider = {
      find: vi.fn().mockReturnValue(null),
      create: vi.fn().mockImplementation((input: { guildId: string }) =>
        Promise.resolve({ ...profile(), guildId: input.guildId }),
      ),
    } as unknown as GuildConfigurationProvider;
    const deployment = {
      deploy: vi.fn().mockResolvedValue(12),
    } as unknown as GuildCommandDeploymentService;
    const panels = {
      ensureGuildPanel: vi.fn().mockResolvedValue(undefined),
    } as unknown as ControlChannelService;
    const logger = { info: vi.fn() } as unknown as Logger;
    const service = new LocalGuildSetupService(provider, deployment, panels, logger);
    const initializedBy = {
      roles: {
        cache: new Map(),
        add,
      },
    } as unknown as GuildMember;

    await service.initialize({
      guild,
      initializedBy,
      displayName: "Test Bot",
      idleImageUrl: null,
      controlChannel: null,
      botAdministratorRole: null,
      musicControllerRole: null,
      restrictedRole: null,
    });

    expect(add).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith(
      botAdministratorRole,
      "Granted during initial bot guild setup",
    );
    expect(add).toHaveBeenCalledWith(
      musicControllerRole,
      "Granted during initial bot guild setup",
    );
  });
});
