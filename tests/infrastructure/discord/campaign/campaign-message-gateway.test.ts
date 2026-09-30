import { describe, expect, it } from "vitest";

import { applicationIcons } from "../../../../src/infrastructure/discord/campaign/campaign-icons.js";
import { DiscordMessageGateway } from "../../../../src/infrastructure/discord/campaign/campaign-message-gateway.js";

// A channel that keeps what it is sent, standing in for Discord.
function gatewayWith(icons?: Parameters<typeof applicationIcons>[0]): { gateway: DiscordMessageGateway; sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  const channel = {
    isTextBased: (): boolean => true,
    isDMBased: (): boolean => false,
    send: (payload: Record<string, unknown>): Promise<{ id: string }> => (sent.push(payload), Promise.resolve({ id: "m1" })),
  };
  const client = { channels: { fetch: (): Promise<typeof channel> => Promise.resolve(channel) } };
  return { gateway: new DiscordMessageGateway(client as never, icons === undefined ? undefined : applicationIcons(icons)), sent };
}

const embedOf = (payload: Record<string, unknown> | undefined): { color?: number; description?: string; thumbnail?: { url: string } } =>
  ((payload?.embeds as { toJSON(): Record<string, unknown> }[] | undefined)?.[0]?.toJSON() ?? {});

describe("styled messages", () => {
  it("draws each kind of message as a coloured panel with its icon in the corner once the icons are uploaded", async () => {
    const { gateway, sent } = gatewayWith((name) => ({ id: `id-${name}`, name }));
    await gateway.post("c1", "Mira rolled a 17.", [], undefined, "roll");
    await gateway.post("c1", "A chest.", [], undefined, "reward");
    expect(embedOf(sent[0])).toMatchObject({ description: "Mira rolled a 17.", thumbnail: { url: "https://cdn.discordapp.com/emojis/id-dnd_roll.png?size=64" } });
    expect(embedOf(sent[1]).thumbnail?.url).toContain("id-dnd_reward");
    expect(sent[0]?.content).toBe("");
  });

  it("leaves narration as plain text, and panels without a corner icon until the icons exist", async () => {
    const { gateway, sent } = gatewayWith();
    await gateway.post("c1", "The wind drops.");
    await gateway.post("c1", "A chest.", [], undefined, "reward");
    expect(sent[0]).toMatchObject({ content: "The wind drops.", embeds: [] });
    expect(embedOf(sent[1]).thumbnail).toBeUndefined();
    expect(embedOf(sent[1]).description).toBe("A chest.");
  });
});
