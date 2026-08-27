import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { LocalGuildSetupService } from "../../src/application/setup/local-guild-setup-service.js";
import type { ControlChannelService } from "../../src/application/control-panel/control-channel-service.js";
import type { GuildCommandDeploymentService } from "../../src/application/commands/guild-command-deployment-service.js";
import type {
  GuildChannelHandle, GuildRoleHandle,
} from "../../src/application/setup/guild-resource-gateway.js";
import type { GuildSetupBotPermissionStatus, GuildSetupInitializeRequest } from "../../src/application/setup/guild-setup-service.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";

const guildId = "123456789012345678";
const channelId = "234567890123456789";
const initializedByUserId = "111111111111111111";

function profile(): GuildConfiguration {
  return {
    schemaVersion: 1,
    guildId,
    guildName: "Test Guild",
    displayName: "Test Bot",
    embedColor: "#3B82F6",
    idleImageUrl: null,
    idleImageAsset: null,
    panel: {
      progressBar: { style: "standard", length: 12, customTheme: null },
    },
    features: { common: true, diagnostics: true, music: true, chatbot: false, birthdays: false, reminders: false, nsfw: false, linkFix: false, retainMemberDataOnLeave: true, ambientReplies: false, channelHistory: false },
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
      birthdayAnnouncements: null,
      joinAnnouncements: null,
      leaveAnnouncements: null,
      linkFix: new Set(),
    },
    timezone: "UTC",
    linkFixPlatforms: {
      twitter: true, threads: true, tiktok: true, instagram: true, reddit: true, bilibili: true,
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
      examplesFile: null,
      examplesAsset: null,
      cooldownSeconds: 30,
      deniedMessage: "Denied",
      deniedLinkUrl: null,
      deniedLinkLabel: null,
      webSearchMode: "off", toolCallingEnabled: false, disabledTools: [],
      imageInputEnabled: false,
      imageGenerationEnabled: false,
      includeSources: true,
      maxImagesPerRequest: 2,
      ambientCooldownSeconds: 20,
      channelHistoryLimit: 8, channelMemoryModes: {}, personaDriftEnabled: false, contextScanChannelIds: [], contextDailyChannelIds: [], contextSeedDays: 7,
    },
    sourceFile: "test.yaml",
  };
}

// Plain function-property shape rather than `GuildResourceGateway` directly
// — the interface declares its methods with method syntax, which trips
// @typescript-eslint/unbound-method wherever a test reads e.g.
// `gateway.createRole` for assertions. Still structurally assignable to
// GuildResourceGateway at the LocalGuildSetupService constructor call site.
type FakeGuildResourceGateway = {
  createRole: (guildId: string, name: string, reason: string) => Promise<GuildRoleHandle>;
  deleteRole: (guildId: string, roleId: string, reason: string) => Promise<void>;
  createTextChannel: (guildId: string, name: string, topic: string, reason: string) => Promise<GuildChannelHandle>;
  deleteChannel: (guildId: string, channelId: string, reason: string) => Promise<void>;
  fetchTextChannel: (guildId: string, channelId: string) => Promise<GuildChannelHandle | null>;
  grantRoleIfMissing: (guildId: string, memberId: string, roleId: string, reason: string) => Promise<void>;
  checkBotPermissions: (guildId: string) => Promise<GuildSetupBotPermissionStatus>;
};

// Every gateway method resolves permissively by default (bot has all
// permissions, created roles/channels get incrementing fake ids); each test
// overrides only the calls whose return value or side effect it cares about.
function fakeGateway(overrides: Partial<FakeGuildResourceGateway> = {}): FakeGuildResourceGateway {
  let nextId = 1;
  return {
    createRole: vi.fn().mockImplementation(() => Promise.resolve({ id: `role-${nextId++}` })),
    deleteRole: vi.fn().mockResolvedValue(undefined),
    createTextChannel: vi.fn().mockImplementation(() => Promise.resolve({ id: channelId })),
    deleteChannel: vi.fn().mockResolvedValue(undefined),
    fetchTextChannel: vi.fn().mockResolvedValue({ id: channelId }),
    grantRoleIfMissing: vi.fn().mockResolvedValue(undefined),
    checkBotPermissions: vi.fn().mockResolvedValue({ ok: true, missing: [] }),
    ...overrides,
  };
}

function baseRequest(overrides: Partial<GuildSetupInitializeRequest> = {}): GuildSetupInitializeRequest {
  return {
    guildId,
    guildName: "Test Guild",
    initializedByUserId,
    displayName: "Test Bot",
    idleImageUrl: null,
    controlChannelId: null,
    botAdministratorRoleId: null,
    musicControllerRoleId: null,
    restrictedRoleId: null,
    ...overrides,
  };
}

describe("LocalGuildSetupService", () => {
  it("resumes an existing profile without creating duplicate Discord resources", async () => {
    const configuredProfile = profile();
    const gateway = fakeGateway();
    const provider = {
      find: vi.fn().mockReturnValue(configuredProfile),
    } as unknown as GuildConfigurationProvider;
    const deploy = vi.fn().mockResolvedValue(12);
    const deployment = { deploy } as unknown as GuildCommandDeploymentService;
    const ensureGuildPanel = vi.fn().mockResolvedValue(undefined);
    const panels = { ensureGuildPanel } as unknown as ControlChannelService;
    const logger = { info: vi.fn() } as unknown as Logger;
    const service = new LocalGuildSetupService(provider, deployment, panels, gateway, logger);

    const result = await service.initialize(baseRequest());

    expect(ensureGuildPanel).toHaveBeenCalledWith(guildId);
    expect(deploy).toHaveBeenCalledWith(configuredProfile);
    expect(result.guildId).toBe(guildId);
    expect(result.controlChannelId).toBe(channelId);
    expect(result.deployedCommandCount).toBe(12);
    expect(gateway.createRole).not.toHaveBeenCalled();
  });

  it("grants bot administrator and music controller roles during first-time setup", async () => {
    const gateway = fakeGateway();
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
    const service = new LocalGuildSetupService(provider, deployment, panels, gateway, logger);

    await service.initialize(baseRequest());

    expect(gateway.grantRoleIfMissing).toHaveBeenCalledTimes(2);
    expect(gateway.grantRoleIfMissing).toHaveBeenCalledWith(
      guildId, initializedByUserId, "role-1", "Granted during initial bot guild setup",
    );
    expect(gateway.grantRoleIfMissing).toHaveBeenCalledWith(
      guildId, initializedByUserId, "role-2", "Granted during initial bot guild setup",
    );
  });

  it("marks first-time setup as fresh and resumed setup as not fresh", async () => {
    const gateway = fakeGateway();
    const provider = {
      find: vi.fn().mockReturnValue(null),
      create: vi.fn().mockImplementation((input: { guildId: string }) =>
        Promise.resolve({ ...profile(), guildId: input.guildId }),
      ),
    } as unknown as GuildConfigurationProvider;
    const deployment = { deploy: vi.fn().mockResolvedValue(12) } as unknown as GuildCommandDeploymentService;
    const panels = { ensureGuildPanel: vi.fn().mockResolvedValue(undefined) } as unknown as ControlChannelService;
    const logger = { info: vi.fn() } as unknown as Logger;
    const service = new LocalGuildSetupService(provider, deployment, panels, gateway, logger);

    const freshResult = await service.initialize(baseRequest());
    expect(freshResult.wasFreshSetup).toBe(true);

    provider.find = vi.fn().mockReturnValue(profile());
    const resumedResult = await service.initialize(baseRequest());
    expect(resumedResult.wasFreshSetup).toBe(false);
  });

  it("rolls back roles and channel it created when setup fails before the profile is persisted", async () => {
    const gateway = fakeGateway();
    const createError = new Error("persistence failed");
    const provider = {
      find: vi.fn().mockReturnValue(null),
      create: vi.fn().mockRejectedValue(createError),
    } as unknown as GuildConfigurationProvider;
    const deployment = {} as unknown as GuildCommandDeploymentService;
    const panels = {} as unknown as ControlChannelService;
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const service = new LocalGuildSetupService(provider, deployment, panels, gateway, logger);

    await expect(service.initialize(baseRequest())).rejects.toBe(createError);

    expect(gateway.deleteRole).toHaveBeenCalledTimes(3);
    expect(gateway.deleteRole).toHaveBeenCalledWith(guildId, "role-1", "Rolling back a failed bot guild setup");
    expect(gateway.deleteRole).toHaveBeenCalledWith(guildId, "role-2", "Rolling back a failed bot guild setup");
    expect(gateway.deleteRole).toHaveBeenCalledWith(guildId, "role-3", "Rolling back a failed bot guild setup");
    expect(gateway.deleteChannel).toHaveBeenCalledWith(guildId, channelId, "Rolling back a failed bot guild setup");
  });

  it("does not roll back resources it did not create itself", async () => {
    const providedRoleId = "999999999999999999";
    const gateway = fakeGateway();
    const createError = new Error("persistence failed");
    const provider = {
      find: vi.fn().mockReturnValue(null),
      create: vi.fn().mockRejectedValue(createError),
    } as unknown as GuildConfigurationProvider;
    const deployment = {} as unknown as GuildCommandDeploymentService;
    const panels = {} as unknown as ControlChannelService;
    const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
    const service = new LocalGuildSetupService(provider, deployment, panels, gateway, logger);

    await expect(service.initialize(baseRequest({ botAdministratorRoleId: providedRoleId })))
      .rejects.toBe(createError);

    expect(gateway.deleteRole).not.toHaveBeenCalledWith(guildId, providedRoleId, expect.anything());
  });

  it("reports missing bot permissions when checking status", async () => {
    const gateway = fakeGateway({
      checkBotPermissions: vi.fn().mockResolvedValue({ ok: false, missing: ["ManageChannels"] }),
    });
    const provider = {
      find: vi.fn().mockReturnValue(null),
    } as unknown as GuildConfigurationProvider;
    const deployment = {} as unknown as GuildCommandDeploymentService;
    const panels = {} as unknown as ControlChannelService;
    const logger = { info: vi.fn() } as unknown as Logger;
    const service = new LocalGuildSetupService(provider, deployment, panels, gateway, logger);

    const status = await service.status(guildId);

    expect(status.botPermissions.ok).toBe(false);
    expect(status.botPermissions.missing).toContain("ManageChannels");
  });

  it("reports bot permissions as ok when the bot has everything it needs", async () => {
    const gateway = fakeGateway();
    const provider = {
      find: vi.fn().mockReturnValue(null),
    } as unknown as GuildConfigurationProvider;
    const deployment = {} as unknown as GuildCommandDeploymentService;
    const panels = {} as unknown as ControlChannelService;
    const logger = { info: vi.fn() } as unknown as Logger;
    const service = new LocalGuildSetupService(provider, deployment, panels, gateway, logger);

    const status = await service.status(guildId);

    expect(status.botPermissions).toEqual({ ok: true, missing: [] });
  });
});
