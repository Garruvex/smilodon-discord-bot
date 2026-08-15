import type { ButtonInteraction, ChatInputCommandInteraction, Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { PollService } from "../../src/application/polls/poll-service.js";

describe("PollService", () => {
  it("records one mutable vote per user and updates totals", async () => {
    const edit = vi.fn().mockResolvedValue(undefined);
    const message = { id: "poll-message", edit } as unknown as Message;
    let initialReply: Record<string, unknown> | undefined;
    const command = {
      user: { username: "Poll Creator" },
      reply: vi.fn((payload: Record<string, unknown>) => {
        initialReply = payload;
        return Promise.resolve();
      }),
      fetchReply: vi.fn().mockResolvedValue(message),
    } as unknown as ChatInputCommandInteraction;
    const polls = new PollService();

    await polls.create(command, "Lunch", "Order pizza?", null);
    const rows = initialReply?.components as { components: { data: { custom_id: string } }[] }[];
    const pollId = rows[0]!.components[0]!.data.custom_id.split(":")[1]!;
    const reply = vi.fn().mockResolvedValue(undefined);
    const buttonBase = {
      user: { id: "voter" },
      message,
      reply,
    };

    await polls.handle({ ...buttonBase, customId: `poll:${pollId}:yes` } as unknown as ButtonInteraction);
    await polls.handle({ ...buttonBase, customId: `poll:${pollId}:no` } as unknown as ButtonInteraction);

    expect(reply).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenCalledTimes(2);
    const latestPayload = edit.mock.calls.at(-1)?.[0] as { embeds: { data: { fields: { name: string; value: string }[] } }[] };
    expect(latestPayload.embeds[0]!.data.fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Yes", value: "0" }),
      expect.objectContaining({ name: "No", value: "1" }),
      expect.objectContaining({ name: "Total", value: "1" }),
    ]));
  });
});
