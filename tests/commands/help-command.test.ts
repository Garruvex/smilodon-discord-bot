import type { EmbedBuilder } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { CommandModule, type BotCommand, type CommandContext } from "../../src/application/commands/command.js";
import { HelpCommand } from "../../src/infrastructure/discord/commands/common/help-command.js";
import { publicAccessPolicy } from "../../src/domain/access/access-policy.js";

function helpFor(command: BotCommand): Promise<{ name: string; value: string }[]> {
  const reply = vi.fn().mockResolvedValue(undefined);
  const help = new HelpCommand(
    { getAll: () => [command] } as never,
    { evaluate: () => ({ allowed: true }) } as never,
    { find: () => undefined } as never,
  );
  return help.execute({
    interaction: { guildId: "guild", options: { getString: () => command.definition.name } },
    responses: { reply },
  } as unknown as CommandContext).then(() => {
    const embed = (reply.mock.calls[0]![0] as { embeds: EmbedBuilder[] }).embeds[0]!;
    return embed.toJSON().fields ?? [];
  });
}

const baseCommand = {
  definition: { name: "demo", description: "A demo command." },
  module: CommandModule.Music,
  access: publicAccessPolicy,
  execute: (): Promise<void> => Promise.resolve(),
} satisfies BotCommand;

describe("HelpCommand", () => {
  it("shows a command's longer explanation under How it works", async () => {
    const fields = await helpFor({ ...baseCommand, helpDetails: ["First line.", "Second line."] });

    expect(fields.find((field) => field.name === "How it works")?.value).toBe("First line.\nSecond line.");
  });

  it("leaves the section out for commands without one", async () => {
    const fields = await helpFor(baseCommand);

    expect(fields.some((field) => field.name === "How it works")).toBe(false);
  });
});
