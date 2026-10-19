import { createHash, randomBytes } from "node:crypto";
import type { Message } from "discord.js";
import type { GeneratedChatImage } from "../../../application/chat/chat-provider.js";
import type { ChannelEditScheduler, ChannelEditSlot } from "../../../application/concurrency/channel-edit-scheduler.js";
import { SocialOutputSuppressed } from "../../../application/chat/message-origin-store.js";
import { chatDeliveryText } from "../../../application/i18n/chat-delivery.js";
import type { ChatDeliveryPayload } from "./chat-turn-support.js";

// One slot owns preview creation, image updates, and the final overwrite.
// Finalization invalidates queued previews before they can replace the answer.
export class ScheduledChatPreview {
  private readonly slot: ChannelEditSlot;
  private readonly nonce = randomBytes(12).toString("hex");
  private signature: string | null = null;
  private finalizing = false;
  private closed = false;
  public message: Message | null = null;
  public constructor(private readonly source: Message, scheduler: ChannelEditScheduler, private readonly authorize: () => Promise<void>, private readonly caption: string = chatDeliveryText.en.preview) {
    this.slot = scheduler.register({ channelId: source.channelId, key: `preview:${source.id}:${this.nonce}`, priority: 1, caller: "chat_text" });
  }
  public async preview(image: GeneratedChatImage): Promise<void> {
    if (this.closed || this.finalizing) return;
    const signature = createHash("sha256").update(image.filename).update(image.data).digest("hex");
    await this.slot.schedule(async () => {
      if (this.closed || this.finalizing || this.signature === signature) return false;
      await this.authorize();
      if (this.closed || this.finalizing) return false;
      const payload = { content: this.caption, files: [{ attachment: image.data, name: image.filename }], allowedMentions: { repliedUser: false, parse: [] as never[] } };
      const editing = this.message !== null;
      this.message = this.message ? await this.message.edit({ ...payload, attachments: [] }) : await this.source.reply({ ...payload, nonce: this.nonce, enforceNonce: true });
      this.signature = signature;
      return editing;
    });
  }
  public async finish(payload: ChatDeliveryPayload, beforeSend: () => Promise<void> = () => Promise.resolve()): Promise<Message> {
    this.finalizing = true;
    let sent: Message | null = null;
    await this.slot.schedule(async () => {
      if (this.closed) return false;
      await this.authorize(); await beforeSend();
      if (this.closed) return false;
      const editing = this.message !== null;
      const body = { content: payload.content, files: [...payload.files], allowedMentions: { repliedUser: false, parse: [] as never[] } };
      sent = this.message ? await this.message.edit({ ...body, attachments: [] }) : await this.source.reply({ ...body, nonce: payload.nonce, enforceNonce: payload.enforceNonce });
      this.message = sent;
      return editing;
    });
    if (!sent) throw new SocialOutputSuppressed();
    return sent;
  }
  public close(): void { this.closed = true; this.slot.unregister(); }
}
