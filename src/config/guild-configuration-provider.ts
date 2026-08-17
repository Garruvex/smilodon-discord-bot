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
} from "./guild-configuration-schema.js";
import {
  applyGuildConfigurationUpdate,
  createGuildConfigurationDocument,
  toGuildConfiguration,
  type CreateGuildConfigurationInput,
  type UpdateGuildConfigurationInput,
} from "./guild-configuration-document.js";

export type { CreateGuildConfigurationInput, UpdateGuildConfigurationInput } from "./guild-configuration-document.js";

export interface GuildConfigurationProvider {
  initialize(): Promise<void>;
  find(guildId: string): GuildConfiguration | null;
  require(guildId: string): GuildConfiguration;
  getAll(): readonly GuildConfiguration[];
  create(input: CreateGuildConfigurationInput): Promise<GuildConfiguration>;
  update(guildId: string, input: UpdateGuildConfigurationInput): Promise<GuildConfiguration>;
  reload(): Promise<void>;
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
