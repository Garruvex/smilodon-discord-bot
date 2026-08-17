import { eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { GuildConfiguration } from "../../config/guild-configuration.js";
import {
  type GuildConfigurationProvider,
} from "../../config/guild-configuration-provider.js";
import {
  createGuildConfigurationDocument,
  applyGuildConfigurationUpdate,
  toGuildConfigurationDocument,
  toGuildConfiguration,
  type CreateGuildConfigurationInput,
  type UpdateGuildConfigurationInput,
} from "../../config/guild-configuration-document.js";
import { guildConfigurationFileSchema } from "../../config/guild-configuration-schema.js";
import * as schema from "../database/schema.js";

export class PostgresGuildConfigurationProvider implements GuildConfigurationProvider {
  private readonly configurations = new Map<string, GuildConfiguration>();

  public constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  public initialize(): Promise<void> {
    return this.reload();
  }

  public async reload(): Promise<void> {
    const rows = await this.database.select().from(schema.guildConfigurations);
    const next = new Map<string, GuildConfiguration>();
    for (const row of rows) {
      const parsed = guildConfigurationFileSchema.safeParse(row.configuration);
      if (!parsed.success) {
        throw new Error(
          `Invalid PostgreSQL guild configuration "${row.guildId}": ${parsed.error.message}`,
        );
      }
      next.set(row.guildId, toGuildConfiguration(parsed.data, `postgres:${row.guildId}`));
    }
    this.configurations.clear();
    for (const [guildId, configuration] of next) {
      this.configurations.set(guildId, configuration);
    }
  }

  public find(guildId: string): GuildConfiguration | null {
    return this.configurations.get(guildId) ?? null;
  }

  public require(guildId: string): GuildConfiguration {
    const configuration = this.find(guildId);
    if (!configuration) throw new Error(`Guild "${guildId}" is not configured.`);
    return configuration;
  }

  public getAll(): readonly GuildConfiguration[] {
    return [...this.configurations.values()];
  }

  public async create(input: CreateGuildConfigurationInput): Promise<GuildConfiguration> {
    if (this.configurations.has(input.guildId)) {
      throw new Error(`Guild "${input.guildId}" is already configured.`);
    }
    const document = createGuildConfigurationDocument(input);
    await this.database.insert(schema.guildConfigurations).values({
      guildId: input.guildId,
      configuration: document,
    });
    const configuration = toGuildConfiguration(document, `postgres:${input.guildId}`);
    this.configurations.set(input.guildId, configuration);
    return configuration;
  }

  public async update(guildId: string, input: UpdateGuildConfigurationInput): Promise<GuildConfiguration> {
    const current = this.require(guildId);
    const document = applyGuildConfigurationUpdate(toGuildConfigurationDocument(current), input);
    await this.database
      .update(schema.guildConfigurations)
      .set({ configuration: document, updatedAt: new Date() })
      .where(eq(schema.guildConfigurations.guildId, guildId));
    const configuration = toGuildConfiguration(document, `postgres:${guildId}`);
    this.configurations.set(guildId, configuration);
    return configuration;
  }

  public async delete(guildId: string): Promise<void> {
    await this.database
      .delete(schema.guildConfigurations)
      .where(eq(schema.guildConfigurations.guildId, guildId));
    this.configurations.delete(guildId);
  }
}
