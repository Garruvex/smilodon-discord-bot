import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { ChatInputCommandInteraction, InteractionEditReplyOptions } from "discord.js";
import { describe, expect, it } from "vitest";

import { templateSetting } from "../../src/infrastructure/discord/commands/setup/settings/template-setting.js";
import type { CommandContext } from "../../src/application/commands/command.js";

function context(kind: string): CommandContext {
  return {
    interaction: {
      options: { getString: () => kind },
    } as unknown as ChatInputCommandInteraction,
    logger: { warn: () => undefined } as never,
    responses: {} as never,
    access: { bypassVoiceChannelCheck: false },
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
