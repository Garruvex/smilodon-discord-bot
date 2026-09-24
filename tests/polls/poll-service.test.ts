import type { ButtonInteraction, ChatInputCommandInteraction, Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { texts } from "../../src/application/i18n/texts.js";
import type { Language } from "../../src/application/i18n/language.js";
import { PollService, type CreatePollInput } from "../../src/application/polls/poll-service.js";

interface Payload {
  embeds: { data: { title: string; description: string; color: number } }[];
  components: { components: { data: { custom_id: string; label: string; disabled?: boolean } }[] }[];
}

interface Click {
  update: ReturnType<typeof vi.fn>;
  reply: ReturnType<typeof vi.fn>;
  payload: Payload | undefined;
}

interface PollHarness {
  initial: Payload;
  click: (userId: string, action: string, canManageMessages?: boolean) => Promise<Click>;
  edit: ReturnType<typeof vi.fn>;
}

async function createPoll(input: Partial<CreatePollInput> = {}, language: Language = "en"): Promise<PollHarness> {
  const edit = vi.fn().mockResolvedValue(undefined);
  const message = { id: "poll-message", edit } as unknown as Message;
  let initial: Payload | undefined;
  const command = {
    guildId: "guild",
    user: { id: "creator", username: "Poll Creator" },
    reply: vi.fn((payload: Payload) => {
      initial = payload;
      return Promise.resolve();
    }),
    fetchReply: vi.fn().mockResolvedValue(message),
  } as unknown as ChatInputCommandInteraction;
  const find = vi.fn().mockReturnValue({ embedColor: "#123456", language, music: { autoQueueVoteBarStyle: "thin" } });
  const polls = new PollService({ find });
  await polls.create(command, { title: "Lunch", description: "What to order?", options: null, durationSeconds: null, ...input });
  const pollId = initial!.components[0]!.components[0]!.data.custom_id.split(":")[1]!;

  const click = async (userId: string, action: string, canManageMessages = false): Promise<Click> => {
    const update = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);
    await polls.handle({
      customId: `poll:${pollId}:${action}`,
      user: { id: userId },
      message,
      memberPermissions: { has: () => canManageMessages },
      update,
      reply,
    } as unknown as ButtonInteraction);
    return { update, reply, payload: update.mock.calls[0]?.[0] as Payload | undefined };
  };
  return { initial: initial!, click, edit };
}

describe("PollService", () => {
  it("writes a Yes/No poll in the server language", async () => {
    const ja = texts.ja.poll;
    const { initial } = await createPoll({}, "ja");
    const embed = initial.embeds[0]!.data;

    expect(embed.title).toBe(ja.title({ title: "Lunch" }));
    expect(embed.description).toContain(`✅ ${ja.yes}`);
    expect(embed.description).toContain(`❌ ${ja.no}`);
    expect(embed.description).toContain(ja.openUntilEnded);
    expect(embed.description).toContain(ja.retractHint);
    expect(initial.components[1]!.components[0]!.data.label).toBe(ja.endButton);
  });

  it("starts a Yes/No poll with the guild's color and an end button", async () => {
    const { initial } = await createPoll();

    expect(initial.embeds[0]!.data.color).toBe(0x123456);
    expect(initial.components[0]!.components.map((button) => button.data.label)).toEqual(["0", "0"]);
    expect(initial.components[1]!.components[0]!.data.custom_id).toMatch(/:end$/);
    expect(initial.embeds[0]!.data.description).toContain("✅ Yes");
  });

  it("keeps one vote per user, switches it, and takes it back on a repeat click", async () => {
    const { click } = await createPoll();

    await click("voter", "0");
    const switched = await click("voter", "1");
    expect(switched.reply).not.toHaveBeenCalled();
    expect(switched.payload!.components[0]!.components.map((button) => button.data.label)).toEqual(["0", "1"]);
    expect(switched.payload!.embeds[0]!.data.description).toContain("▶ **❌ No**");

    const retracted = await click("voter", "1");
    expect(retracted.payload!.components[0]!.components.map((button) => button.data.label)).toEqual(["0", "0"]);
    expect(retracted.payload!.embeds[0]!.data.description).not.toContain("▶");
  });

  it("supports custom choices", async () => {
    const { initial, click } = await createPoll({ options: ["Pizza", "Sushi", "Tacos"] });

    expect(initial.components[0]!.components).toHaveLength(3);
    const voted = await click("voter", "2");
    expect(voted.payload!.embeds[0]!.data.description).toContain("▶ **3️⃣ Tacos**");
  });

  it("only lets the creator or a moderator end the poll, then announces the result", async () => {
    const { click } = await createPoll({ options: ["Pizza", "Sushi"] });
    await click("a", "0");
    await click("b", "0");
    await click("c", "1");

    const denied = await click("stranger", "end");
    expect(denied.update).not.toHaveBeenCalled();
    expect(denied.reply.mock.calls[0]?.[0]).toMatchObject({ content: "Only the poll creator or a moderator can end this poll." });

    const ended = await click("moderator", "end", true);
    const embed = ended.payload!.embeds[0]!.data;
    expect(embed.title).toContain("ended");
    expect(embed.description).toContain("Winner: 1️⃣ Pizza** (2 of 3 votes)");
    expect(ended.payload!.components).toHaveLength(1);
    expect(ended.payload!.components[0]!.components.every((button) => button.data.disabled)).toBe(true);

    const late = await click("a", "1");
    expect(late.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "This poll is no longer active." }));
  });

  it("reports ties and closes on its timer", async () => {
    vi.useFakeTimers();
    try {
      const { click, edit } = await createPoll({ durationSeconds: 30 });
      await click("a", "0");
      await click("b", "1");

      await vi.advanceTimersByTimeAsync(30_000);

      const payload = edit.mock.calls.at(-1)?.[0] as Payload;
      expect(payload.embeds[0]!.data.description).toContain("Tie between ✅ Yes, ❌ No** (1 vote each, 2 total)");
    } finally {
      vi.useRealTimers();
    }
  });
});
