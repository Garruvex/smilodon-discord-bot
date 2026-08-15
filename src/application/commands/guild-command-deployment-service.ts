import type { GuildConfiguration } from "../../config/guild-configuration.js";

export interface GuildCommandDeploymentService {
  deployBootstrap(): Promise<number>;
  deploy(profile: GuildConfiguration): Promise<number>;
}
