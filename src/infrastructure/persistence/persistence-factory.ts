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
import type { ReminderStore } from "../../application/reminders/reminder-store.js";
import { LocalReminderStore } from "./local-reminder-store.js";
import { PostgresReminderStore } from "./postgres-reminder-store.js";
import type { RoleMenuStore } from "../../application/roles/role-menu-store.js";
import { LocalRoleMenuStore } from "./local-role-menu-store.js";
import { PostgresRoleMenuStore } from "./postgres-role-menu-store.js";
import { GuildMemberRegistry } from "./guild-member-registry.js";
import type { MemoryRepository } from "../../application/memory/memory.js";
import { SqliteMemoryRepository } from "./sqlite-memory-repository.js";
import { PostgresMemoryRepository } from "./postgres-memory-repository.js";
import type { MemberDataPurger } from "../../application/members/member-data-purger.js";
import { LocalMemberDataPurger } from "./local-member-data-purger.js";
import { PostgresMemberDataPurger } from "./postgres-member-data-purger.js";
import type { ChannelSummaryCheckpointStore } from "../../application/context/channel-summary-checkpoint-store.js";
import { SqliteChannelSummaryCheckpointStore } from "./sqlite-channel-summary-checkpoint-store.js";
import { PostgresChannelSummaryCheckpointStore } from "./postgres-channel-summary-checkpoint-store.js";
import type { PersonalMemoryExtractionQueueStore } from "../../application/context/personal-memory-extraction-queue.js";
import { SqlitePersonalMemoryExtractionQueueStore } from "./sqlite-personal-memory-extraction-queue-store.js";
import { PostgresPersonalMemoryExtractionQueueStore } from "./postgres-personal-memory-extraction-queue-store.js";

export interface PersistenceServices {
  guildConfigurationProvider: GuildConfigurationProvider;
  controlPanelStateStore: ControlPanelStateStore;
  chatStateStore: ChatStateStore;
  userCustomizationStore: UserCustomizationStore;
  guildKnowledgeStore: GuildKnowledgeStore;
  memoryRepository: MemoryRepository;
  channelSummaryCheckpointStore: ChannelSummaryCheckpointStore;
  personalMemoryExtractionQueueStore: PersonalMemoryExtractionQueueStore;
  birthdayStore: BirthdayStore;
  reminderStore: ReminderStore;
  roleMenuStore: RoleMenuStore;
  memberDataPurger: MemberDataPurger;
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
  let channelSummaryCheckpointStore: ChannelSummaryCheckpointStore;
  let personalMemoryExtractionQueueStore: PersonalMemoryExtractionQueueStore;
  let birthdayStore: BirthdayStore;
  let reminderStore: ReminderStore;
  let roleMenuStore: RoleMenuStore;
  let guildMemberRegistry: GuildMemberRegistry | null = null;
  let memberDataPurger: MemberDataPurger;

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
    channelSummaryCheckpointStore = new PostgresChannelSummaryCheckpointStore(connection.database);
    personalMemoryExtractionQueueStore = new PostgresPersonalMemoryExtractionQueueStore(connection.database);
    birthdayStore = new PostgresBirthdayStore(connection.database, guildMemberRegistry);
    reminderStore = new PostgresReminderStore(connection.database);
    roleMenuStore = new PostgresRoleMenuStore(connection.database);
    memberDataPurger = new PostgresMemberDataPurger(connection.database, personalMemoryExtractionQueueStore);
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
    channelSummaryCheckpointStore = new SqliteChannelSummaryCheckpointStore(sqliteConnection.database);
    personalMemoryExtractionQueueStore = new SqlitePersonalMemoryExtractionQueueStore(sqliteConnection.database);
    birthdayStore = new LocalBirthdayStore(configuration.runtimeDataDirectory);
    reminderStore = new LocalReminderStore(configuration.runtimeDataDirectory);
    roleMenuStore = new LocalRoleMenuStore(configuration.runtimeDataDirectory);
    memberDataPurger = new LocalMemberDataPurger(
      memoryRepository,
      userCustomizationStore,
      birthdayStore,
      reminderStore,
      chatStateStore,
      personalMemoryExtractionQueueStore,
    );
  }

  await guildConfigurationProvider.initialize();
  await controlPanelStateStore.initialize();
  await chatStateStore.initialize();
  await userCustomizationStore.initialize();
  await guildKnowledgeStore.initialize();
  await channelSummaryCheckpointStore.initialize();
  await personalMemoryExtractionQueueStore.initialize();
  await birthdayStore.initialize();
  await reminderStore.initialize();
  await roleMenuStore.initialize();

  return {
    guildConfigurationProvider,
    controlPanelStateStore,
    chatStateStore,
    userCustomizationStore,
    guildKnowledgeStore,
    memoryRepository,
    channelSummaryCheckpointStore,
    personalMemoryExtractionQueueStore,
    birthdayStore,
    reminderStore,
    roleMenuStore,
    memberDataPurger,
    close: async (): Promise<void> => {
      await connection?.close();
      sqliteConnection?.close();
    },
  };
}
