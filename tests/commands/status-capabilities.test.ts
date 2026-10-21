import { describe, expect, it, vi } from "vitest";
import type { EmbedBuilder } from "discord.js";
import type { CommandContext } from "../../src/application/commands/command.js";
import { AdminPanelHealth } from "../../src/application/settings/admin-panel-health.js";
import { texts } from "../../src/application/i18n/texts.js";
import { StatusCommand } from "../../src/infrastructure/discord/commands/setup/status-command.js";
import { freshDocument, guildId, memoryProvider } from "../helpers/settings-fixtures.js";

describe("operator capability status", () => {
  it.each(["en", "zh-TW", "ja"] as const)("distinguishes enabled settings from available guarded capabilities in %s", async (language) => {
    const document = freshDocument();
    document.chat.webSearchMode = "auto"; document.chat.toolCallingEnabled = true;
    document.chat.imageInputEnabled = true; document.chat.imageGenerationEnabled = true;
    const profiles = memoryProvider(document);
    await profiles.update(guildId, { character: { context: { ...profiles.current().character!.context, enabled: true, retrievalMode: "eligible_count" } } });
    const profile = profiles.current();
    const setup = { initialize: vi.fn(), status: vi.fn(() => Promise.resolve({ configured: true, profileFile: "test.yaml", controlPanelChannelId: null,
      enabledFeatures: [], featureStates: [], access: null, music: null, chat: profile.chat, panel: null, botPermissions: { ok: true, missing: [] } })) };
    const reply = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve());
    const command = new StatusCommand(setup, profiles, new AdminPanelHealth(), {
      chat: { provider: "openai-responses", models: ["test"], summaryModels: ["test"] }, utility: null, embeddings: null,
    }, () => true);
    await command.execute({ interaction: { guildId, channelId: "channel" }, text: texts[language], responses: { reply } } as unknown as CommandContext);
    const payload = reply.mock.calls[0]?.[0] as { embeds: EmbedBuilder[] };
    const fields = payload.embeds[0]!.toJSON().fields!;
    const text = texts[language].setup.status;
    const configured = fields.find((field) => field.name === text.chat.title)!;
    const effective = fields.find((field) => field.name === text.chat.effectiveTitle)!;
    expect(configured.value).toContain(text.chat.images({ read: text.on, make: text.on }));
    expect(effective.value).toContain(text.chat.tools({ webSearch: text.auto, tools: text.off }));
    expect(effective.value).toContain(text.chat.images({ read: text.off, make: text.off }));
    expect(effective.value).toContain(text.chat.excludedSources);
  });
});
