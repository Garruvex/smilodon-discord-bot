import { Application, createDiscordClient } from "./application.js";
import { createDependencies } from "./dependencies.js";
import { loadConfiguration } from "../config/environment.js";
import { createLogger } from "../infrastructure/logging/logger.js";
import { LavalinkPlayerGateway } from "../infrastructure/lavalink/lavalink-player-gateway.js";
import { MusicEventBus } from "../application/music/music-event-bus.js";
import { ControlChannelService } from "../application/control-panel/control-channel-service.js";
import { DeferredGuildSetupService } from "../application/setup/guild-setup-service.js";
import { LocalGuildSetupService } from "../application/setup/local-guild-setup-service.js";
import { DiscordGuildCommandDeploymentService } from "../infrastructure/discord/commands/discord-guild-command-deployment-service.js";
import { createPersistenceServices } from "../infrastructure/persistence/persistence-factory.js";
import { MusicPresenceService } from "../application/music/music-presence-service.js";

const configuration = loadConfiguration();
const logger = createLogger(configuration);
const persistence = await createPersistenceServices(configuration);
const guildConfigurationProvider = persistence.guildConfigurationProvider;
const discordClient = createDiscordClient();
const musicEventBus = new MusicEventBus();
const musicPlayerGateway = new LavalinkPlayerGateway(
  discordClient,
  configuration.lavalink,
  logger,
  musicEventBus,
  guildConfigurationProvider,
);
const deferredGuildSetupService = new DeferredGuildSetupService();
const dependencies = createDependencies(
  configuration,
  logger,
  musicPlayerGateway,
  guildConfigurationProvider,
  deferredGuildSetupService,
  discordClient,
);
const controlPanelStateStore = persistence.controlPanelStateStore;
const controlChannelService = new ControlChannelService(
  discordClient,
  configuration,
  guildConfigurationProvider,
  controlPanelStateStore,
  musicPlayerGateway,
  dependencies.playbackService,
  logger,
  musicEventBus,
);
const commandDeploymentService = new DiscordGuildCommandDeploymentService(
  configuration,
  dependencies.commandRegistry,
);
const musicPresenceService = new MusicPresenceService(
  discordClient,
  guildConfigurationProvider,
  musicPlayerGateway,
  logger,
  musicEventBus,
);
deferredGuildSetupService.setService(
  new LocalGuildSetupService(
    guildConfigurationProvider,
    commandDeploymentService,
    controlChannelService,
    logger,
  ),
);
const application = new Application(
  discordClient,
  configuration,
  dependencies,
  controlChannelService,
  musicPresenceService,
  logger,
);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  await application.stop(signal);
  await persistence.close();
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (error) => {
  logger.fatal({ error }, "Unhandled promise rejection");
  void shutdown("unhandledRejection");
});

process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught exception");
  void shutdown("uncaughtException");
});

await application.start();
