import { registerCommands } from "../bootstrap/dependencies.js";
import { loadConfiguration } from "../config/environment.js";
import { createLogger } from "../infrastructure/logging/logger.js";
import type { MusicPlayerGateway } from "../application/music/music-player-gateway.js";
import { DiscordGuildCommandDeploymentService } from "../infrastructure/discord/commands/discord-guild-command-deployment-service.js";
import { DeferredGuildSetupService } from "../application/setup/guild-setup-service.js";
import { createPersistenceServices } from "../infrastructure/persistence/persistence-factory.js";
import { createDiscordClient } from "../bootstrap/application.js";
import { AuditLogService } from "../application/audit/audit-log-service.js";

const configuration = loadConfiguration();
const logger = createLogger(configuration);
const persistence = await createPersistenceServices(configuration);
const guildConfigurationProvider = persistence.guildConfigurationProvider;
const discordClient = createDiscordClient();
const auditLogService = new AuditLogService(discordClient, guildConfigurationProvider, logger);
const unavailableMusicGateway: MusicPlayerGateway = {
  initialize: () => Promise.resolve(),
  acceptDiscordGatewayPayload: () => undefined,
  enqueue: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  pause: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  resume: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  stop: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  skip: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  skipTo: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  previous: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  changeVolume: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  setVolume: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  shuffle: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  getQueue: () => [],
  getPlayHistory: () => [],
  removeQueueTrack: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  moveQueueTrack: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  clearQueue: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  seek: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  replay: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  setRepeatMode: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  setFilterPreset: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  toggleAutoQueue: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  toggleTwentyFourSeven: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  handleBotVoiceDisconnect: () => Promise.resolve(),
  handleVoiceChannelOccupancy: () => undefined,
  handleGuildRemoved: () => Promise.resolve(),
  hasPlayer: () => false,
  isPaused: () => false,
  getVoiceChannelId: () => null,
  getSnapshot: () => null,
};
// Only the command registry is needed to deploy — registerCommands() builds
// just that (and its supporting services), not the full chat/behavior/
// scheduler runtime createDependencies() assembles for the live bot.
const { commandRegistry } = registerCommands(
  configuration,
  logger,
  unavailableMusicGateway,
  guildConfigurationProvider,
  new DeferredGuildSetupService(),
  discordClient,
  persistence.chatStateStore,
  persistence.userCustomizationStore,
  auditLogService,
  persistence.birthdayStore,
  persistence.memoryRepository,
  persistence.channelSummaryCheckpointStore,
  persistence.reminderStore,
  persistence.roleMenuStore,
);
const deploymentService = new DiscordGuildCommandDeploymentService(
  configuration,
  commandRegistry,
);

const bootstrapCommandCount = await deploymentService.deployBootstrap();
logger.info(
  { commandCount: bootstrapCommandCount },
  "Deployed global bootstrap commands",
);

function requestedGuildId(arguments_: readonly string[]): string | null {
  const guildFlagIndex = arguments_.indexOf("--guild");
  if (guildFlagIndex === -1) return null;

  const guildId = arguments_[guildFlagIndex + 1];
  if (!guildId) {
    throw new Error("The --guild option requires a guild ID.");
  }

  return guildId;
}

const selectedGuildId = requestedGuildId(process.argv.slice(2));
const profiles = selectedGuildId
  ? [guildConfigurationProvider.require(selectedGuildId)]
  : guildConfigurationProvider.getAll();

for (const profile of profiles) {
  const commandCount = await deploymentService.deploy(profile);

  logger.info(
    {
      commandCount,
      guildId: profile.guildId,
      guildName: profile.guildName,
    },
    "Deployed guild commands",
  );
}

await persistence.close();
