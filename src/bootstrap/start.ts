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
import { AuditLogService } from "../application/audit/audit-log-service.js";
import { BirthdayAnnouncer } from "../application/birthdays/birthday-announcer.js";

const configuration = loadConfiguration();
const logger = createLogger(configuration);
const persistence = await createPersistenceServices(configuration);
const guildConfigurationProvider = persistence.guildConfigurationProvider;
const discordClient = createDiscordClient();
const musicEventBus = new MusicEventBus();
const musicPlayerGateway = new LavalinkPlayerGateway(
  discordClient,
  configuration.lavalink,
  logger.child({ component: "lavalink" }),
  musicEventBus,
  guildConfigurationProvider,
);
const auditLogService = new AuditLogService(
  discordClient,
  guildConfigurationProvider,
  logger.child({ component: "audit-log" }),
);
const deferredGuildSetupService = new DeferredGuildSetupService();
const dependencies = createDependencies(
  configuration,
  logger,
  musicPlayerGateway,
  guildConfigurationProvider,
  deferredGuildSetupService,
  discordClient,
  persistence.chatStateStore,
  persistence.userCustomizationStore,
  persistence.guildKnowledgeStore,
  auditLogService,
  persistence.birthdayStore,
);
const controlPanelStateStore = persistence.controlPanelStateStore;
const controlChannelService = new ControlChannelService(
  discordClient,
  configuration,
  guildConfigurationProvider,
  controlPanelStateStore,
  musicPlayerGateway,
  dependencies.playbackService,
  dependencies.applicationEmojiCatalog,
  logger.child({ component: "control-panel" }),
  musicEventBus,
);
dependencies.settingsCommand.bindControlChannelService(controlChannelService);
const commandDeploymentService = new DiscordGuildCommandDeploymentService(
  configuration,
  dependencies.commandRegistry,
);
const musicPresenceService = new MusicPresenceService(
  discordClient,
  guildConfigurationProvider,
  musicPlayerGateway,
  logger.child({ component: "music-presence" }),
  musicEventBus,
);
const birthdayAnnouncer = new BirthdayAnnouncer(
  discordClient,
  guildConfigurationProvider,
  persistence.birthdayStore,
  logger.child({ component: "birthdays" }),
);
deferredGuildSetupService.setService(
  new LocalGuildSetupService(
    guildConfigurationProvider,
    commandDeploymentService,
    controlChannelService,
    logger.child({ component: "guild-setup" }),
    auditLogService,
  ),
);
const application = new Application(
  discordClient,
  configuration,
  dependencies,
  controlChannelService,
  musicPresenceService,
  birthdayAnnouncer,
  logger.child({ component: "application" }),
  (reason) => {
    void shutdown(reason, 1);
  },
);

let shuttingDown = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  try {
    await application.stop(signal);
    await persistence.close();
  } catch (error) {
    logger.error({ error, signal }, "Shutdown did not complete cleanly");
    process.exit(exitCode === 0 ? 1 : exitCode);
  }
  process.exit(exitCode);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("unhandledRejection", (error) => {
  logger.fatal({ error }, "Unhandled promise rejection");
  void shutdown("unhandledRejection", 1);
});

process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught exception");
  void shutdown("uncaughtException", 1);
});

await application.start();
