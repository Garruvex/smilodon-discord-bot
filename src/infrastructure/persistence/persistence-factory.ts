import type { ControlPanelStateStore } from "../../application/control-panel/control-panel-state-store.js";
import type { ChatStateStore } from "../../application/chat/chat-state-store.js";
import type { ApplicationConfiguration } from "../../config/configuration.js";
import {
  LocalGuildConfigurationProvider,
  type GuildConfigurationProvider,
} from "../../config/guild-configuration-provider.js";
import {
  createDatabaseConnection,
  resolveInstanceSchemaName,
  type DatabaseConnection,
} from "../database/database.js";
import { createSqliteDatabaseConnection, type SqliteDatabaseConnection } from "../database/sqlite-database.js";
import { LocalControlPanelStateStore } from "./local-control-panel-state-store.js";
import { PostgresControlPanelStateStore } from "./postgres-control-panel-state-store.js";
import { PostgresGuildConfigurationProvider } from "./postgres-guild-configuration-provider.js";
import { SqliteChatStateStore } from "./sqlite-chat-state-store.js";
import { PostgresChatStateStore } from "./postgres-chat-state-store.js";
import type { UserCustomizationStore } from "../../application/chat/user-customization-store.js";
import { LocalUserCustomizationStore } from "./local-user-customization-store.js";
import { PostgresUserCustomizationStore } from "./postgres-user-customization-store.js";
import type { GuildKnowledgeStore } from "../../application/chat/guild-knowledge-store.js";
import { SqliteGuildKnowledgeStore } from "./sqlite-guild-knowledge-store.js";
import { PostgresGuildKnowledgeStore } from "./postgres-guild-knowledge-store.js";
import type { BirthdayStore } from "../../application/birthdays/birthday-store.js";
import { LocalBirthdayStore } from "./local-birthday-store.js";
import { PostgresBirthdayStore } from "./postgres-birthday-store.js";
import { GuildMemberRegistry } from "./guild-member-registry.js";
import type { MemoryRepository } from "../../application/memory/memory.js";
import { SqliteMemoryRepository } from "./sqlite-memory-repository.js";
import { PostgresMemoryRepository } from "./postgres-memory-repository.js";

export interface PersistenceServices {
  guildConfigurationProvider: GuildConfigurationProvider;
  controlPanelStateStore: ControlPanelStateStore;
  chatStateStore: ChatStateStore;
  userCustomizationStore: UserCustomizationStore;
  guildKnowledgeStore: GuildKnowledgeStore;
  memoryRepository: MemoryRepository;
  birthdayStore: BirthdayStore;
  // Null on the local (file-based) backend, which has no hub-table concept —
  // it's purely a dev/testing convenience and doesn't need it.
  guildMemberRegistry: GuildMemberRegistry | null;
  close(): Promise<void>;
}

export async function createPersistenceServices(
  configuration: ApplicationConfiguration,
): Promise<PersistenceServices> {
  let connection: DatabaseConnection | null = null;
  let sqliteConnection: SqliteDatabaseConnection | null = null;
  let guildConfigurationProvider: GuildConfigurationProvider;
  let controlPanelStateStore: ControlPanelStateStore;
  let chatStateStore: ChatStateStore;
  let userCustomizationStore: UserCustomizationStore;
  let guildKnowledgeStore: GuildKnowledgeStore;
  let memoryRepository: MemoryRepository;
  let birthdayStore: BirthdayStore;
  let guildMemberRegistry: GuildMemberRegistry | null = null;

  if (configuration.persistence.driver === "postgres") {
    const databaseUrl = configuration.persistence.databaseUrl;
    if (!databaseUrl) throw new Error("PostgreSQL persistence requires DATABASE_URL.");
    if (!configuration.instanceName) {
      throw new Error("PostgreSQL persistence requires INSTANCE_NAME for schema isolation.");
    }
    const schemaName = resolveInstanceSchemaName(configuration.instanceName);
    connection = await createDatabaseConnection(databaseUrl, schemaName);
    guildMemberRegistry = new GuildMemberRegistry(connection.database);
    guildConfigurationProvider = new PostgresGuildConfigurationProvider(connection.database);
    controlPanelStateStore = new PostgresControlPanelStateStore(connection.database);
    chatStateStore = new PostgresChatStateStore(connection.database, guildMemberRegistry);
    userCustomizationStore = new PostgresUserCustomizationStore(connection.database, guildMemberRegistry);
    guildKnowledgeStore = new PostgresGuildKnowledgeStore(connection.database);
    memoryRepository = new PostgresMemoryRepository(connection.database);
    birthdayStore = new PostgresBirthdayStore(connection.database, guildMemberRegistry);
  } else {
    guildConfigurationProvider = new LocalGuildConfigurationProvider(
      configuration.guildConfigurationDirectory,
    );
    controlPanelStateStore = new LocalControlPanelStateStore(
      configuration.runtimeDataDirectory,
    );
    // SQLite (not raw JSON files) for exactly these two — see
    // sqlite-schema.ts's header comment. Everything else on this backend
    // stays JSON/YAML, unaffected.
    sqliteConnection = createSqliteDatabaseConnection(configuration.runtimeDataDirectory);
    chatStateStore = new SqliteChatStateStore(sqliteConnection.database);
    userCustomizationStore = new LocalUserCustomizationStore(configuration.runtimeDataDirectory);
    guildKnowledgeStore = new SqliteGuildKnowledgeStore(sqliteConnection.database);
    memoryRepository = new SqliteMemoryRepository(sqliteConnection.database);
    birthdayStore = new LocalBirthdayStore(configuration.runtimeDataDirectory);
  }

  await guildConfigurationProvider.initialize();
  await controlPanelStateStore.initialize();
  await chatStateStore.initialize();
  await userCustomizationStore.initialize();
  await guildKnowledgeStore.initialize();
  await birthdayStore.initialize();

  return {
    guildConfigurationProvider,
    controlPanelStateStore,
    chatStateStore,
    userCustomizationStore,
    guildKnowledgeStore,
    memoryRepository,
    birthdayStore,
    guildMemberRegistry,
    close: async (): Promise<void> => {
      await connection?.close();
      sqliteConnection?.close();
    },
  };
}
