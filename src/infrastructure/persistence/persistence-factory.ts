import type { ControlPanelStateStore } from "../../application/control-panel/control-panel-state-store.js";
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

export interface PersistenceServices {
  guildConfigurationProvider: GuildConfigurationProvider;
  controlPanelStateStore: ControlPanelStateStore;
  close(): Promise<void>;
}

export async function createPersistenceServices(
  configuration: ApplicationConfiguration,
): Promise<PersistenceServices> {
  let connection: DatabaseConnection | null = null;
  let guildConfigurationProvider: GuildConfigurationProvider;
  let controlPanelStateStore: ControlPanelStateStore;

  if (configuration.persistence.driver === "postgres") {
    const databaseUrl = configuration.persistence.databaseUrl;
    if (!databaseUrl) throw new Error("PostgreSQL persistence requires DATABASE_URL.");
    connection = createDatabaseConnection(databaseUrl);
    guildConfigurationProvider = new PostgresGuildConfigurationProvider(connection.database);
    controlPanelStateStore = new PostgresControlPanelStateStore(connection.database);
  } else {
    guildConfigurationProvider = new LocalGuildConfigurationProvider(
      configuration.guildConfigurationDirectory,
    );
    controlPanelStateStore = new LocalControlPanelStateStore(
      configuration.runtimeDataDirectory,
    );
  }

  await guildConfigurationProvider.initialize();
  await controlPanelStateStore.initialize();

  return {
    guildConfigurationProvider,
    controlPanelStateStore,
    close: async () => connection?.close(),
  };
}
