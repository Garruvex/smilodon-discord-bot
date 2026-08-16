import type { ControlPanelStateStore } from "../../application/control-panel/control-panel-state-store.js";
import type { ChatStateStore } from "../../application/chat/chat-state-store.js";
import type { ApplicationConfiguration } from "../../config/configuration.js";
import {
  LocalGuildConfigurationProvider,
  type GuildConfigurationProvider,
} from "../../config/guild-configuration-provider.js";
import {
  createDatabaseConnection,
  type DatabaseConnection,
} from "../database/database.js";
import { LocalControlPanelStateStore } from "./local-control-panel-state-store.js";
import { PostgresControlPanelStateStore } from "./postgres-control-panel-state-store.js";
import { PostgresGuildConfigurationProvider } from "./postgres-guild-configuration-provider.js";
import { LocalChatStateStore } from "./local-chat-state-store.js";
import { PostgresChatStateStore } from "./postgres-chat-state-store.js";
import type { GuildKnowledgeStore } from "../../application/chat/guild-knowledge-store.js";
import { LocalGuildKnowledgeStore } from "./local-guild-knowledge-store.js";
import { PostgresGuildKnowledgeStore } from "./postgres-guild-knowledge-store.js";

export interface PersistenceServices {
  guildConfigurationProvider: GuildConfigurationProvider;
  controlPanelStateStore: ControlPanelStateStore;
  chatStateStore: ChatStateStore;
  guildKnowledgeStore: GuildKnowledgeStore;
  close(): Promise<void>;
}

export async function createPersistenceServices(
  configuration: ApplicationConfiguration,
): Promise<PersistenceServices> {
  let connection: DatabaseConnection | null = null;
  let guildConfigurationProvider: GuildConfigurationProvider;
  let controlPanelStateStore: ControlPanelStateStore;
  let chatStateStore: ChatStateStore;
  let guildKnowledgeStore: GuildKnowledgeStore;

  if (configuration.persistence.driver === "postgres") {
    const databaseUrl = configuration.persistence.databaseUrl;
    if (!databaseUrl) throw new Error("PostgreSQL persistence requires DATABASE_URL.");
    connection = createDatabaseConnection(databaseUrl);
    guildConfigurationProvider = new PostgresGuildConfigurationProvider(connection.database);
    controlPanelStateStore = new PostgresControlPanelStateStore(connection.database);
    chatStateStore = new PostgresChatStateStore(connection.database);
    guildKnowledgeStore = new PostgresGuildKnowledgeStore(connection.database);
  } else {
    guildConfigurationProvider = new LocalGuildConfigurationProvider(
      configuration.guildConfigurationDirectory,
    );
    controlPanelStateStore = new LocalControlPanelStateStore(
      configuration.runtimeDataDirectory,
    );
    chatStateStore = new LocalChatStateStore(configuration.runtimeDataDirectory);
    guildKnowledgeStore = new LocalGuildKnowledgeStore(configuration.runtimeDataDirectory);
  }

  await guildConfigurationProvider.initialize();
  await controlPanelStateStore.initialize();
  await chatStateStore.initialize();
  await guildKnowledgeStore.initialize();

  return {
    guildConfigurationProvider,
    controlPanelStateStore,
    chatStateStore,
    guildKnowledgeStore,
    close: async () => connection?.close(),
  };
}
