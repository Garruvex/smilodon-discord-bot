import type { Language } from "../../src/application/i18n/language.js";
import { SettingsUpdateService } from "../../src/application/settings/settings-update-service.js";
import {
  applyGuildConfigurationUpdate,
  createGuildConfigurationDocument,
  toGuildConfiguration,
} from "../../src/config/guild-configuration-document.js";
import type { GuildConfiguration } from "../../src/config/guild-configuration.js";
import type { GuildConfigurationProvider, UpdateGuildConfigurationInput } from "../../src/config/guild-configuration-provider.js";
import { guildConfigurationFileSchema, type ParsedGuildConfigurationFile } from "../../src/config/guild-configuration-schema.js";
import type { SettingDeps, SettingValues } from "../../src/infrastructure/discord/settings/engine/request.js";
import { SettingsEngine, type SettingRunResult } from "../../src/infrastructure/discord/settings/engine/settings-engine.js";
import { settingsRegistry } from "../../src/infrastructure/discord/settings/groups/index.js";
import type { SettingsGroup } from "../../src/infrastructure/discord/settings/registry/types.js";

export const guildId = "123456789012345678";
export const actorUserId = "890123456789012345";

export function freshDocument(): ParsedGuildConfigurationFile {
  return createGuildConfigurationDocument({
    guildId,
    guildName: "Test Guild",
    displayName: "Test Bot",
    embedColor: "#3B82F6",
    idleImageUrl: null,
    botAdministratorRoleIds: ["200000000000000001"],
    musicControllerRoleIds: ["300000000000000001"],
    restrictedRoleIds: [],
    controlPanelChannelId: "500000000000000001",
  });
}

export const freshProfile = (): GuildConfiguration => toGuildConfiguration(freshDocument(), "test.yaml");

// A provider over the real config document: updates go through the same
// applyGuildConfigurationUpdate and schema validation as a stored config.
export function memoryProvider(
  document: ParsedGuildConfigurationFile = freshDocument(),
): GuildConfigurationProvider & { current(): GuildConfiguration } {
  let stored = document;
  const current = (): GuildConfiguration => toGuildConfiguration(stored, "test.yaml");
  return {
    current,
    initialize: () => Promise.resolve(),
    find: current,
    require: current,
    getAll: () => [current()],
    create: () => Promise.resolve(current()),
    update: (_guildId: string, input: UpdateGuildConfigurationInput): Promise<GuildConfiguration> => {
      stored = guildConfigurationFileSchema.parse(applyGuildConfigurationUpdate(stored, input));
      return Promise.resolve(current());
    },
    reload: () => Promise.resolve(),
  };
}

export const stubEmojiCatalog = (missingYohta = false): SettingDeps["applicationEmojiCatalog"] => ({
  getYohtaTheme: () => (missingYohta ? null : {}),
  getMissingYohtaEmojiNames: () => (missingYohta ? ["progressed"] : []),
}) as unknown as SettingDeps["applicationEmojiCatalog"];

export interface EngineFixture {
  engine: SettingsEngine;
  updater: SettingsUpdateService;
  profiles: ReturnType<typeof memoryProvider>;
  run(path: string, values: SettingValues, language?: Language): Promise<SettingRunResult>;
}

// The real settings engine over the given registry (the real one by
// default), a fresh profile, and stub services.
export function engineFixture(options: {
  registry?: readonly SettingsGroup[];
  deps?: Partial<SettingDeps>;
  document?: ParsedGuildConfigurationFile;
} = {}): EngineFixture {
  const profiles = memoryProvider(options.document);
  const deps: SettingDeps = { assets: {} as never, applicationEmojiCatalog: stubEmojiCatalog(), ...options.deps };
  const updater = new SettingsUpdateService(profiles, deps.assets);
  const engine = new SettingsEngine({ registry: options.registry ?? settingsRegistry, profiles, updater, deps });
  return {
    engine,
    updater,
    profiles,
    run: (path, values, language = "en"): Promise<SettingRunResult> => {
      const registered = engine.find(path);
      if (!registered) throw new Error(`No setting at "${path}".`);
      return engine.run(registered, { guildId, guild: null, actorUserId, language, values }, { kind: "panel" });
    },
  };
}

// Slash-command-shaped values, as interaction.options would give them.
export function slashValues(options: Record<string, string | number | boolean | { id: string }>): SettingValues {
  const get = (name: string): unknown => options[name] ?? null;
  return {
    getString: get,
    getInteger: get,
    getBoolean: get,
    getChannel: get,
    getRole: get,
    getAttachment: get,
  } as unknown as SettingValues;
}
