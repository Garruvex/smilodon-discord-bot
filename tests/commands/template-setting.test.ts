import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { InteractionEditReplyOptions } from "discord.js";
import { describe, expect, it } from "vitest";

import { templateSetting } from "../../src/infrastructure/discord/settings/definitions/template-setting.js";
import type { SettingRequest, SettingValues } from "../../src/infrastructure/discord/settings/definitions/setting-definition.js";

function context(kind: string): SettingRequest {
  return {
    guildId: "guild",
    guild: null,
    actorUserId: "user",
    language: "en",
    values: { getString: () => kind } as unknown as SettingValues,
  };
}

describe("templateSetting", () => {
  it("attaches the committed personality template with its own filename", async () => {
    const result = await templateSetting.run(context("personality"), {} as never, {} as never) as InteractionEditReplyOptions;
    const expectedContent = readFileSync(resolve("config/examples/personality.example.md"), "utf8");

    expect(result.files).toHaveLength(1);
    const attachment = result.files![0] as { name?: string; attachment: Buffer };
    expect(attachment.name).toBe("personality.md");
    expect(attachment.attachment.toString("utf8")).toBe(expectedContent);
    expect(result.content).toContain("/settings chat chatbot personality:<file>");
  });

  it("attaches the committed examples template with its own filename", async () => {
    const result = await templateSetting.run(context("examples"), {} as never, {} as never) as InteractionEditReplyOptions;
    const expectedContent = readFileSync(resolve("config/examples/examples.example.md"), "utf8");

    expect(result.files).toHaveLength(1);
    const attachment = result.files![0] as { name?: string; attachment: Buffer };
    expect(attachment.name).toBe("examples.md");
    expect(attachment.attachment.toString("utf8")).toBe(expectedContent);
    expect(result.content).toContain("/settings chat chatbot examples:<file>");
  });
});
