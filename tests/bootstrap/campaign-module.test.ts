import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Client } from "discord.js";
import { afterEach, describe, expect, it } from "vitest";

import type { AccessPolicyService } from "../../src/application/access/access-policy-service.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import { createCampaignModule } from "../../src/bootstrap/campaign-module.js";
import { createLogger } from "../../src/infrastructure/logging/logger.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function build(model: ApplicationConfiguration["campaign"]): { module: ReturnType<typeof createCampaignModule>; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "campaign-module-"));
  directories.push(directory);
  const configuration = { runtimeDataDirectory: directory, campaign: model, logLevel: "fatal", environment: "test" } as unknown as ApplicationConfiguration;
  const module = createCampaignModule({
    configuration,
    logger: createLogger(configuration),
    client: {} as Client,
    accessPolicyService: {} as AccessPolicyService,
  });
  return { module, directory };
}

describe("the campaign module", () => {
  it("builds without touching the disk, and registers a /dnd command in the campaign module", () => {
    const { module, directory } = build(null);
    expect(existsSync(join(directory, "campaign.sqlite"))).toBe(false);
    expect(module.command.definition.name).toBe("dnd");
    expect(module.command.module).toBe("campaign");
    expect(module.handler.customIdPrefix).toBe("dnd");
  });

  it("opens its database and recovers on start, then closes cleanly", async () => {
    const { module, directory } = build({ provider: "openai-responses", apiKey: "k", baseUrl: "https://example.invalid/v1", models: ["m"], reasoningEffort: "none" });
    await module.start();
    expect(existsSync(join(directory, "campaign.sqlite"))).toBe(true);
    await module.stop();
  });
});
