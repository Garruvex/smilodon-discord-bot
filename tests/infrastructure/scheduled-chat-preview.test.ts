import { Collection, type Message } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelEditScheduler } from "../../src/application/concurrency/channel-edit-scheduler.js";
import { ScheduledChatPreview } from "../../src/infrastructure/discord/behaviors/scheduled-chat-preview.js";
import { SocialOutputSuppressed } from "../../src/application/chat/message-origin-store.js";
import type { GeneratedChatImage } from "../../src/application/chat/chat-provider.js";
import type { ChatResponseObserver } from "../../src/application/chat/chat-provider.js";
import type { ChatConversationService } from "../../src/application/chat/chat-conversation-service.js";
import type { ResolvedPersona } from "../../src/application/chat/persona-source.js";
import type { ApplicationConfiguration } from "../../src/config/configuration.js";
import type { Logger } from "pino";
import { MentionChatBehavior } from "../../src/infrastructure/discord/behaviors/mention-chat-behavior.js";
import { freshDocument, memoryProvider, guildId } from "../helpers/settings-fixtures.js";
import { decisionResponse } from "../helpers/conversation-decision-fixtures.js";

const image = (value: string): GeneratedChatImage => ({ data: Buffer.from(value), filename: "preview.png", contentType: "image/png" });
const final = { content: "Final answer", files: [], nonce: "abcdef0123456789abcdef01", enforceNonce: true as const };
function fixture(): { preview: ScheduledChatPreview; scheduler: ChannelEditScheduler; reply: ReturnType<typeof vi.fn>;
  edit: ReturnType<typeof vi.fn>; authorize: ReturnType<typeof vi.fn>; visible: () => string } {
  const scheduler = new ChannelEditScheduler({ maxEdits: 1, windowMs: 5000 }); let content = "";
  const edit = vi.fn((payload: { content: string }): Promise<Message> => { content = payload.content; return Promise.resolve(message); });
  const message = { id: "preview", edit } as unknown as Message;
  const reply = vi.fn((payload: { content: string }): Promise<Message> => { content = payload.content; return Promise.resolve(message); });
  const source = { id: "source", channelId: "channel", reply } as unknown as Message;
  const authorize = vi.fn(() => Promise.resolve());
  return { preview: new ScheduledChatPreview(source, scheduler, authorize), scheduler, reply, edit, authorize, visible: () => content };
}
afterEach(() => vi.useRealTimers());
describe("scheduled image previews", () => {
  it("ignores even the first preview callback if it arrives after the mention turn has ended", async () => {
    const document = freshDocument(); document.features.chatbot = true; document.features.music = false;
    const profiles = memoryProvider(document); const reply = vi.fn(() => Promise.resolve({ id: "preview" }));
    const observers: ChatResponseObserver[] = [];
    const run = vi.fn((_input: unknown, _deliver: unknown, observer: ChatResponseObserver) => { observers.push(observer); return Promise.resolve(decisionResponse()); });
    const source = { id: "source", guildId, channelId: "channel", inGuild: () => true, client: { user: { id: "bot" } },
      author: { id: "human", username: "Human", displayName: "Human", bot: false },
      member: { guild: { id: guildId }, roles: { cache: new Collection([["200000000000000001", { id: "200000000000000001", name: "admin" }]]) } },
      content: "<@bot>", attachments: new Collection(), mentions: { users: new Collection() },
      channel: { sendTyping: () => Promise.resolve() }, reply } as unknown as Message;
    const behavior = new MentionChatBehavior(() => "bot", { ownerUserIds: new Set(), chat: null, chatDelivery: { maxGeneratedImageAggregateBytes: 1000000 } } as unknown as ApplicationConfiguration,
      profiles, { isBusy: () => false, run } as unknown as ChatConversationService,
      { resolve: (): Promise<ResolvedPersona> => Promise.resolve({ personality: "Friendly", personalitySourceHash: "hash", personaDrift: null, loreChunks: [], examplePool: [] }) },
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger);
    await behavior.execute(source); expect(run).toHaveBeenCalledOnce();
    await observers[0]!.onImagePreview(image("late")); expect(reply).not.toHaveBeenCalled();
  });
  it("creates once with a nonce and skips identical image updates", async () => {
    const f = fixture(); await f.preview.preview(image("one")); await f.preview.preview(image("one"));
    expect(f.reply).toHaveBeenCalledOnce(); expect(f.reply).toHaveBeenCalledWith(expect.objectContaining({ enforceNonce: true })); expect(f.edit).not.toHaveBeenCalled(); f.preview.close(); f.scheduler.stop();
  });
  it("lets finalization replace queued previews and ignores late images", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.preview.preview(image("one")); await f.preview.preview(image("two"));
    const older = f.preview.preview(image("three")); const done = f.preview.finish(final);
    await vi.advanceTimersByTimeAsync(4999); expect(f.edit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); await Promise.all([older, done]);
    await f.preview.preview(image("late")); expect(f.edit).toHaveBeenCalledTimes(2); expect(f.visible()).toBe("Final answer");
    expect(f.edit).toHaveBeenLastCalledWith(expect.objectContaining({ content: "Final answer", attachments: [] })); f.preview.close(); f.scheduler.stop();
  });
  it("can finalize before a queued preview is created", async () => {
    const f = fixture(); const pending = f.preview.preview(image("one")); const done = f.preview.finish(final);
    await Promise.all([pending, done]); expect(f.reply).toHaveBeenCalledOnce(); expect(f.visible()).toBe("Final answer"); f.preview.close(); f.scheduler.stop();
  });
  it("rechecks source access after waiting for the edit budget", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.preview.preview(image("one")); await f.preview.preview(image("two"));
    const done = f.preview.finish(final); const assertion = expect(done).rejects.toBeInstanceOf(SocialOutputSuppressed);
    f.authorize.mockRejectedValue(new SocialOutputSuppressed()); await vi.advanceTimersByTimeAsync(5000); await assertion;
    expect(f.edit).toHaveBeenCalledOnce(); f.preview.close(); f.scheduler.stop();
  });
  it("honors server backoff before the final overwrite", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.preview.preview(image("one"));
    const failure = Object.assign(new Error("rate limited"), { retryAfter: 20000 }); f.edit.mockRejectedValueOnce(failure);
    await expect(f.preview.preview(image("two"))).rejects.toBe(failure);
    const done = f.preview.finish(final); await vi.advanceTimersByTimeAsync(19999); expect(f.edit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); await done; expect(f.visible()).toBe("Final answer"); f.preview.close(); f.scheduler.stop();
  });
  it("drops pending work on close without claiming final delivery", async () => {
    vi.useFakeTimers(); const f = fixture(); await f.preview.preview(image("one")); await f.preview.preview(image("two"));
    const pending = f.preview.preview(image("three")); f.preview.close(); await pending;
    await expect(f.preview.finish(final)).rejects.toBeInstanceOf(SocialOutputSuppressed); await vi.advanceTimersByTimeAsync(10000);
    expect(f.edit).toHaveBeenCalledOnce(); f.scheduler.stop();
  });
});
