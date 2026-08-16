import { createDependencies } from "../bootstrap/dependencies.js";
import { loadConfiguration } from "../config/environment.js";
import { createLogger } from "../infrastructure/logging/logger.js";
import type { MusicPlayerGateway } from "../application/music/music-player-gateway.js";
import { DiscordGuildCommandDeploymentService } from "../infrastructure/discord/commands/discord-guild-command-deployment-service.js";
import { DeferredGuildSetupService } from "../application/setup/guild-setup-service.js";
import { createPersistenceServices } from "../infrastructure/persistence/persistence-factory.js";
import { createDiscordClient } from "../bootstrap/application.js";

const configuration = loadConfiguration();
const logger = createLogger(configuration);
const persistence = await createPersistenceServices(configuration);
const guildConfigurationProvider = persistence.guildConfigurationProvider;
const unavailableMusicGateway: MusicPlayerGateway = {
  initialize: () => Promise.resolve(),
  acceptDiscordGatewayPayload: () => undefined,
  enqueue: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  pause: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  resume: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  stop: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  skip: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  previous: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  changeVolume: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  setVolume: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  shuffle: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  getQueue: () => [],
  removeQueueTrack: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  clearQueue: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  setRepeatMode: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  toggleAutoQueue: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  toggleTwentyFourSeven: () => Promise.reject(new Error("Music is unavailable during command deployment.")),
  handleBotVoiceDisconnect: () => Promise.resolve(),
  handleVoiceChannelOccupancy: () => undefined,
  hasPlayer: () => false,
  isPaused: () => false,
  getVoiceChannelId: () => null,
  getSnapshot: () => null,
};
const dependencies = createDependencies(
  configuration,
  logger,
  unavailableMusicGateway,
  guildConfigurationProvider,
  new DeferredGuildSetupService(),
  createDiscordClient(),
  persistence.chatStateStore,
  persistence.guildKnowledgeStore,
);
const deploymentService = new DiscordGuildCommandDeploymentService(
  configuration,
  dependencies.commandRegistry,
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
