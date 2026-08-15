import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalGuildConfigurationProvider } from "../../src/config/guild-configuration-provider.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "fntu-guild-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

function validProfile(guildId = "123456789012345678"): string {
  return `
schemaVersion: 1
guild:
  id: "${guildId}"
  name: "Test Guild"
features:
  common: true
  diagnostics: true
  music: true
roles:
  musicController:
    - "234567890123456789"
channels:
  musicCommands:
    - "345678901234567890"
music:
  volume:
    default: 80
    maximum: 120
    buttonStep: 10
`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("LocalGuildConfigurationProvider", () => {
  it("loads and normalizes a valid guild profile", () => {
    const directory = createTemporaryDirectory();
    writeFileSync(join(directory, "guild.yaml"), validProfile(), "utf8");

    const provider = new LocalGuildConfigurationProvider(directory);
    const profile = provider.require("123456789012345678");

    expect(profile.guildName).toBe("Test Guild");
    expect(profile.features.music).toBe(true);
    expect(profile.roles.musicController).toEqual(
      new Set(["234567890123456789"]),
    );
    expect(profile.music.defaultVolume).toBe(80);
    expect(profile.music.emptyQueueAction).toBe("disconnect");
  });

  it("rejects duplicate profiles for the same guild", () => {
    const directory = createTemporaryDirectory();
    writeFileSync(join(directory, "first.yaml"), validProfile(), "utf8");
    writeFileSync(join(directory, "second.yaml"), validProfile(), "utf8");

    expect(() => new LocalGuildConfigurationProvider(directory)).toThrow(
      "configured more than once",
    );
  });

  it("rejects music without a controller role", () => {
    const directory = createTemporaryDirectory();
    writeFileSync(
      join(directory, "invalid.yaml"),
      validProfile().replace(
        'musicController:\n    - "234567890123456789"',
        "musicController: []",
      ),
      "utf8",
    );

    expect(() => new LocalGuildConfigurationProvider(directory)).toThrow(
      "Music requires at least one musicController role",
    );
  });

  it("rejects a default volume above the maximum", () => {
    const directory = createTemporaryDirectory();
    writeFileSync(
      join(directory, "invalid.yaml"),
      validProfile().replace("default: 80", "default: 150"),
      "utf8",
    );

    expect(() => new LocalGuildConfigurationProvider(directory)).toThrow(
      "Default volume cannot exceed maximum volume",
    );
  });

  it("creates and reloads a new guild profile atomically", async () => {
    const directory = createTemporaryDirectory();
    const provider = new LocalGuildConfigurationProvider(directory);

    const created = await provider.create({
      guildId: "123456789012345678",
      guildName: "Created Guild",
      displayName: "Created Bot",
      embedColor: "#3B82F6",
      idleImageUrl: null,
      botAdministratorRoleIds: ["234567890123456789"],
      musicControllerRoleIds: ["345678901234567890"],
      restrictedRoleIds: ["456789012345678901"],
      controlPanelChannelId: "567890123456789012",
    });

    expect(created.guildName).toBe("Created Guild");
    expect(created.channels.controlPanel).toBe("567890123456789012");
    expect(new LocalGuildConfigurationProvider(directory).find(created.guildId)).not.toBeNull();
  });

  it("refuses to overwrite an existing guild profile", async () => {
    const directory = createTemporaryDirectory();
    writeFileSync(join(directory, "guild.yaml"), validProfile(), "utf8");
    const provider = new LocalGuildConfigurationProvider(directory);

    await expect(
      provider.create({
        guildId: "123456789012345678",
        guildName: "Duplicate",
        displayName: "Duplicate",
        embedColor: "#3B82F6",
        idleImageUrl: null,
        botAdministratorRoleIds: ["234567890123456789"],
        musicControllerRoleIds: ["345678901234567890"],
        restrictedRoleIds: ["456789012345678901"],
        controlPanelChannelId: "567890123456789012",
      }),
    ).rejects.toThrow("already configured");
  });

  it("updates settings atomically and keeps the normalized cache current", async () => {
    const directory = createTemporaryDirectory();
    writeFileSync(join(directory, "guild.yaml"), validProfile(), "utf8");
    const provider = new LocalGuildConfigurationProvider(directory);

    const updated = await provider.update("123456789012345678", {
      idleImageUrl: "https://example.com/idle.png",
      maximumVolume: 180,
      emptyQueueAction: "stay_connected",
    });

    expect(updated.idleImageUrl).toBe("https://example.com/idle.png");
    expect(updated.music.maximumVolume).toBe(180);
    expect(updated.music.emptyQueueAction).toBe("stay_connected");
    expect(provider.require(updated.guildId)).toEqual(updated);
  });

  it("rejects invalid setting combinations without changing the profile", async () => {
    const directory = createTemporaryDirectory();
    writeFileSync(join(directory, "guild.yaml"), validProfile(), "utf8");
    const provider = new LocalGuildConfigurationProvider(directory);

    await expect(provider.update("123456789012345678", {
      maximumVolume: 50,
    })).rejects.toThrow("Default volume cannot exceed maximum volume");

    expect(provider.require("123456789012345678").music.maximumVolume).toBe(120);
  });
});
