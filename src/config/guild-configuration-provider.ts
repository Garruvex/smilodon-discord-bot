import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import type { GuildConfiguration } from "./guild-configuration.js";
import {
  guildConfigurationFileSchema,
  type ParsedGuildConfigurationFile,
} from "./guild-configuration-schema.js";

export interface GuildConfigurationProvider {
  initialize(): Promise<void>;
  find(guildId: string): GuildConfiguration | null;
  require(guildId: string): GuildConfiguration;
  getAll(): readonly GuildConfiguration[];
  create(input: CreateGuildConfigurationInput): Promise<GuildConfiguration>;
  update(guildId: string, input: UpdateGuildConfigurationInput): Promise<GuildConfiguration>;
  reload(): Promise<void>;
}

export interface UpdateGuildConfigurationInput {
  idleImageUrl?: string | null;
  idleImageAsset?: string | null;
  controlPanelChannelId?: string;
  botAdministratorRoleIds?: readonly string[];
  musicControllerRoleIds?: readonly string[];
  restrictedRoleIds?: readonly string[];
  chatbotRoleIds?: readonly string[];
  chatbotChannelIds?: readonly string[];
  chatbotEnabled?: boolean;
  chatbotPersonalityFile?: string | null;
  chatbotPersonalityAsset?: string | null;
  chatbotCooldownSeconds?: number;
  chatbotDeniedMessage?: string;
  chatbotWebSearchEnabled?: boolean;
  chatbotImageInputEnabled?: boolean;
  chatbotIncludeSources?: boolean;
  chatbotMaxImagesPerRequest?: number;
  defaultVolume?: number;
  maximumVolume?: number;
  volumeButtonStep?: number;
  emptyQueueAction?: "disconnect" | "stay_connected";
  emptyQueueDelayMs?: number;
  emptyChannelAction?: "continue" | "pause" | "disconnect";
  emptyChannelGracePeriodMs?: number;
  resumeWhenOccupied?: boolean;
}

export interface CreateGuildConfigurationInput {
  guildId: string;
  guildName: string;
  displayName: string;
  embedColor: string;
  idleImageUrl: string | null;
  botAdministratorRoleIds: readonly string[];
  musicControllerRoleIds: readonly string[];
  restrictedRoleIds: readonly string[];
  controlPanelChannelId: string;
}

export class LocalGuildConfigurationProvider implements GuildConfigurationProvider {
  private readonly configurations = new Map<string, GuildConfiguration>();
  private readonly absoluteDirectory: string;

  public constructor(directory: string) {
    this.absoluteDirectory = resolve(directory);
    mkdirSync(this.absoluteDirectory, { recursive: true });
    this.reloadFromDisk();
  }

  public initialize(): Promise<void> {
    return Promise.resolve();
  }

  public reload(): Promise<void> {
    this.reloadFromDisk();
    return Promise.resolve();
  }

  private reloadFromDisk(): void {
    const nextConfigurations = new Map<string, GuildConfiguration>();
    let files: string[];

    try {
      files = readdirSync(this.absoluteDirectory)
        .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
        .sort();
    } catch (error) {
      throw new Error(
        `Unable to read guild configuration directory "${this.absoluteDirectory}".`,
        { cause: error },
      );
    }

    for (const file of files) {
      const sourceFile = resolve(this.absoluteDirectory, file);
      if (!statSync(sourceFile).isFile()) {
        continue;
      }

      const configuration = this.loadFile(sourceFile);
      if (nextConfigurations.has(configuration.guildId)) {
        throw new Error(
          `Guild "${configuration.guildId}" is configured more than once. Duplicate found in "${sourceFile}".`,
        );
      }

      nextConfigurations.set(configuration.guildId, configuration);
    }

    this.configurations.clear();
    for (const [guildId, configuration] of nextConfigurations) {
      this.configurations.set(guildId, configuration);
    }
  }

  public find(guildId: string): GuildConfiguration | null {
    return this.configurations.get(guildId) ?? null;
  }

  public require(guildId: string): GuildConfiguration {
    const configuration = this.find(guildId);
    if (!configuration) {
      throw new Error(`Guild "${guildId}" has no local configuration profile.`);
    }

    return configuration;
  }

  public getAll(): readonly GuildConfiguration[] {
    return [...this.configurations.values()];
  }

  public async create(input: CreateGuildConfigurationInput): Promise<GuildConfiguration> {
    await this.initialize();
    if (this.configurations.has(input.guildId)) {
      throw new Error(`Guild "${input.guildId}" is already configured.`);
    }

    const document = createGuildConfigurationDocument(input);

    const validation = guildConfigurationFileSchema.safeParse(document);
    if (!validation.success) {
      throw new Error(`Generated guild configuration is invalid: ${validation.error.message}`);
    }

    const targetFile = resolve(this.absoluteDirectory, `${input.guildId}.yaml`);
    const temporaryFile = `${targetFile}.tmp`;
    if (existsSync(targetFile)) {
      throw new Error(`Guild profile file "${targetFile}" already exists.`);
    }

    writeFileSync(temporaryFile, stringifyYaml(document), "utf8");
    renameSync(temporaryFile, targetFile);

    try {
      this.reloadFromDisk();
      return this.require(input.guildId);
    } catch (error) {
      rmSync(targetFile, { force: true });
      this.reloadFromDisk();
      throw new Error("Generated guild configuration failed full-set validation.", {
        cause: error,
      });
    }
  }

  public async update(
    guildId: string,
    input: UpdateGuildConfigurationInput,
  ): Promise<GuildConfiguration> {
    await this.initialize();
    const current = this.require(guildId);
    const targetFile = current.sourceFile;
    const parsed = guildConfigurationFileSchema.parse(
      parseYaml(readFileSync(targetFile, "utf8")),
    );
    const document = applyGuildConfigurationUpdate(parsed, input);
    const temporaryFile = `${targetFile}.tmp`;
    writeFileSync(temporaryFile, stringifyYaml(document), "utf8");
    renameSync(temporaryFile, targetFile);
    this.reloadFromDisk();
    return this.require(guildId);
  }

  private loadFile(sourceFile: string): GuildConfiguration {
    let document: unknown;

    try {
      document = parseYaml(readFileSync(sourceFile, "utf8"));
    } catch (error) {
      throw new Error(`Unable to parse guild configuration "${sourceFile}".`, {
        cause: error,
      });
    }

    const result = guildConfigurationFileSchema.safeParse(document);
    if (!result.success) {
      const details = result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
      throw new Error(`Invalid guild configuration "${sourceFile}": ${details}`);
    }

    return toGuildConfiguration(result.data, sourceFile);
  }
}

export function createGuildConfigurationDocument(
  input: CreateGuildConfigurationInput,
): ParsedGuildConfigurationFile {
  return guildConfigurationFileSchema.parse({
    schemaVersion: 1,
    guild: { id: input.guildId, name: input.guildName },
    branding: {
      displayName: input.displayName,
      embedColor: input.embedColor,
      idleImageUrl: input.idleImageUrl,
      idleImageAsset: null,
    },
    features: { common: true, diagnostics: true, music: true, chatbot: false },
    roles: {
      botAdministrator: [...input.botAdministratorRoleIds],
      musicController: [...input.musicControllerRoleIds],
      restricted: [...input.restrictedRoleIds],
      chatbot: [],
    },
    channels: {
      musicCommands: [],
      controlPanel: input.controlPanelChannelId,
      auditLog: null,
      chatbot: [],
    },
    music: {
      volume: { default: 75, maximum: 150, buttonStep: 10 },
      emptyQueue: { action: "disconnect", delayMs: 120_000 },
      emptyChannel: {
        action: "pause",
        gracePeriodMs: 30_000,
        resumeWhenOccupied: true,
      },
    },
    chat: {
      personalityFile: null,
      personalityAsset: null,
      cooldownSeconds: 30,
      deniedMessage: "This feature requires a premium subscription. Try looking richer and ask again.",
      webSearchEnabled: false,
      imageInputEnabled: false,
      includeSources: true,
      maxImagesPerRequest: 2,
    },
  });
}

export function toGuildConfiguration(
  parsed: ParsedGuildConfigurationFile,
  sourceFile: string,
): GuildConfiguration {
  return {
    schemaVersion: 1,
    guildId: parsed.guild.id,
    guildName: parsed.guild.name,
    displayName: parsed.branding.displayName,
    embedColor: parsed.branding.embedColor,
    idleImageUrl: parsed.branding.idleImageUrl,
    idleImageAsset: parsed.branding.idleImageAsset,
    features: parsed.features,
    roles: {
      botAdministrator: new Set(parsed.roles.botAdministrator),
      musicController: new Set(parsed.roles.musicController),
      restricted: new Set(parsed.roles.restricted),
      chatbot: new Set(parsed.roles.chatbot),
    },
    channels: {
      musicCommands: new Set(parsed.channels.musicCommands),
      controlPanel: parsed.channels.controlPanel,
      auditLog: parsed.channels.auditLog,
      chatbot: new Set(parsed.channels.chatbot),
    },
    music: {
      defaultVolume: parsed.music.volume.default,
      maximumVolume: parsed.music.volume.maximum,
      volumeButtonStep: parsed.music.volume.buttonStep,
      emptyQueueAction: parsed.music.emptyQueue.action,
      emptyQueueDelayMs: parsed.music.emptyQueue.delayMs,
      emptyChannelAction: parsed.music.emptyChannel.action,
      emptyChannelGracePeriodMs: parsed.music.emptyChannel.gracePeriodMs,
      resumeWhenOccupied: parsed.music.emptyChannel.resumeWhenOccupied,
    },
    chat: {
      personalityFile: parsed.chat.personalityFile,
      personalityAsset: parsed.chat.personalityAsset,
      cooldownSeconds: parsed.chat.cooldownSeconds,
      deniedMessage: parsed.chat.deniedMessage,
      webSearchEnabled: parsed.chat.webSearchEnabled,
      imageInputEnabled: parsed.chat.imageInputEnabled,
      includeSources: parsed.chat.includeSources,
      maxImagesPerRequest: parsed.chat.maxImagesPerRequest,
    },
    sourceFile,
  };
}

export function toGuildConfigurationDocument(
  configuration: GuildConfiguration,
): ParsedGuildConfigurationFile {
  return guildConfigurationFileSchema.parse({
    schemaVersion: 1,
    guild: { id: configuration.guildId, name: configuration.guildName },
    branding: {
      displayName: configuration.displayName,
      embedColor: configuration.embedColor,
      idleImageUrl: configuration.idleImageUrl,
      idleImageAsset: configuration.idleImageAsset,
    },
    features: configuration.features,
    roles: {
      botAdministrator: [...configuration.roles.botAdministrator],
      musicController: [...configuration.roles.musicController],
      restricted: [...configuration.roles.restricted],
      chatbot: [...configuration.roles.chatbot],
    },
    channels: {
      musicCommands: [...configuration.channels.musicCommands],
      controlPanel: configuration.channels.controlPanel,
      auditLog: configuration.channels.auditLog,
      chatbot: [...configuration.channels.chatbot],
    },
    music: {
      volume: {
        default: configuration.music.defaultVolume,
        maximum: configuration.music.maximumVolume,
        buttonStep: configuration.music.volumeButtonStep,
      },
      emptyQueue: {
        action: configuration.music.emptyQueueAction,
        delayMs: configuration.music.emptyQueueDelayMs,
      },
      emptyChannel: {
        action: configuration.music.emptyChannelAction,
        gracePeriodMs: configuration.music.emptyChannelGracePeriodMs,
        resumeWhenOccupied: configuration.music.resumeWhenOccupied,
      },
    },
    chat: {
      personalityFile: configuration.chat.personalityFile,
      personalityAsset: configuration.chat.personalityAsset,
      cooldownSeconds: configuration.chat.cooldownSeconds,
      deniedMessage: configuration.chat.deniedMessage,
      webSearchEnabled: configuration.chat.webSearchEnabled,
      imageInputEnabled: configuration.chat.imageInputEnabled,
      includeSources: configuration.chat.includeSources,
      maxImagesPerRequest: configuration.chat.maxImagesPerRequest,
    },
  });
}

export function applyGuildConfigurationUpdate(
  document: ParsedGuildConfigurationFile,
  input: UpdateGuildConfigurationInput,
): ParsedGuildConfigurationFile {
  const next = structuredClone(document);
  if (input.idleImageUrl !== undefined) next.branding.idleImageUrl = input.idleImageUrl;
  if (input.idleImageAsset !== undefined) next.branding.idleImageAsset = input.idleImageAsset;
  if (input.controlPanelChannelId !== undefined) next.channels.controlPanel = input.controlPanelChannelId;
  if (input.botAdministratorRoleIds !== undefined) next.roles.botAdministrator = [...input.botAdministratorRoleIds];
  if (input.musicControllerRoleIds !== undefined) next.roles.musicController = [...input.musicControllerRoleIds];
  if (input.restrictedRoleIds !== undefined) next.roles.restricted = [...input.restrictedRoleIds];
  if (input.chatbotRoleIds !== undefined) next.roles.chatbot = [...input.chatbotRoleIds];
  if (input.chatbotChannelIds !== undefined) next.channels.chatbot = [...input.chatbotChannelIds];
  if (input.chatbotEnabled !== undefined) next.features.chatbot = input.chatbotEnabled;
  if (input.chatbotPersonalityFile !== undefined) next.chat.personalityFile = input.chatbotPersonalityFile;
  if (input.chatbotPersonalityAsset !== undefined) next.chat.personalityAsset = input.chatbotPersonalityAsset;
  if (input.chatbotCooldownSeconds !== undefined) next.chat.cooldownSeconds = input.chatbotCooldownSeconds;
  if (input.chatbotDeniedMessage !== undefined) next.chat.deniedMessage = input.chatbotDeniedMessage;
  if (input.chatbotWebSearchEnabled !== undefined) next.chat.webSearchEnabled = input.chatbotWebSearchEnabled;
  if (input.chatbotImageInputEnabled !== undefined) next.chat.imageInputEnabled = input.chatbotImageInputEnabled;
  if (input.chatbotIncludeSources !== undefined) next.chat.includeSources = input.chatbotIncludeSources;
  if (input.chatbotMaxImagesPerRequest !== undefined) next.chat.maxImagesPerRequest = input.chatbotMaxImagesPerRequest;
  if (input.defaultVolume !== undefined) next.music.volume.default = input.defaultVolume;
  if (input.maximumVolume !== undefined) next.music.volume.maximum = input.maximumVolume;
  if (input.volumeButtonStep !== undefined) next.music.volume.buttonStep = input.volumeButtonStep;
  if (input.emptyQueueAction !== undefined) next.music.emptyQueue.action = input.emptyQueueAction;
  if (input.emptyQueueDelayMs !== undefined) next.music.emptyQueue.delayMs = input.emptyQueueDelayMs;
  if (input.emptyChannelAction !== undefined) next.music.emptyChannel.action = input.emptyChannelAction;
  if (input.emptyChannelGracePeriodMs !== undefined) next.music.emptyChannel.gracePeriodMs = input.emptyChannelGracePeriodMs;
  if (input.resumeWhenOccupied !== undefined) next.music.emptyChannel.resumeWhenOccupied = input.resumeWhenOccupied;
  return guildConfigurationFileSchema.parse(next);
}
