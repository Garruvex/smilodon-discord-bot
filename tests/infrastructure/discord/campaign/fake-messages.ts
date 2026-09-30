import type { CampaignMessageGateway, MessageStyle } from "../../../../src/infrastructure/discord/campaign/campaign-message-gateway.js";
import type { CardPayload } from "../../../../src/infrastructure/discord/campaign/card-payload.js";

export interface Sent {
  channelId: string;
  messageId: string;
  payload: CardPayload;
  removed: boolean;
}

export class FakeMessages implements CampaignMessageGateway {
  public readonly sent: Sent[] = [];
  public readonly edits: string[] = [];
  public readonly pinned: string[] = [];
  public failSends = 0;
  public failEdits = 0;
  public readonly deleted = new Set<string>();
  private next = 0;

  public send(channelId: string, payload: CardPayload): Promise<string> {
    if (this.failSends > 0) {
      this.failSends -= 1;
      return Promise.reject(new Error("Missing Permissions"));
    }
    this.next += 1;
    const messageId = `m${this.next}`;
    this.sent.push({ channelId, messageId, payload, removed: false });
    return Promise.resolve(messageId);
  }

  public edit(_channelId: string, messageId: string, payload: CardPayload): Promise<"ok" | "missing"> {
    if (this.failEdits > 0) {
      this.failEdits -= 1;
      return Promise.reject(new Error("Request timed out"));
    }
    const message = this.sent.find((candidate) => candidate.messageId === messageId);
    if (message === undefined || this.deleted.has(messageId)) return Promise.resolve("missing");
    message.payload = payload;
    this.edits.push(messageId);
    return Promise.resolve("ok");
  }

  public exists(channelId: string, messageId: string): Promise<boolean> {
    return Promise.resolve(this.sent.some((message) => message.channelId === channelId && message.messageId === messageId && !message.removed && !this.deleted.has(messageId)));
  }

  public remove(_channelId: string, messageId: string): Promise<void> {
    const message = this.sent.find((candidate) => candidate.messageId === messageId);
    if (message !== undefined) message.removed = true;
    return Promise.resolve();
  }

  public readonly posts: { channelId: string; content: string; order: number; mentions: readonly string[]; nonce: string | undefined; style: MessageStyle | undefined }[] = [];

  public post(channelId: string, content: string, mentions: readonly string[] = [], nonce?: string, style?: MessageStyle): Promise<string> {
    this.next += 1;
    this.posts.push({ channelId, content, order: this.next, mentions, nonce, style });
    return Promise.resolve(`p${this.next}`);
  }

  public readonly images: { channelId: string; caption: string; bytes: number }[] = [];

  public sendImage(channelId: string, bytes: Buffer, _mediaType: string, caption: string): Promise<void> {
    this.images.push({ channelId, caption, bytes: bytes.byteLength });
    return Promise.resolve();
  }

  public readonly textEdits: { messageId: string; content: string }[] = [];

  public editText(_channelId: string, messageId: string, content: string, _style?: MessageStyle): Promise<"ok" | "missing"> {
    const post = this.posts.find((candidate) => `p${candidate.order}` === messageId);
    if (post === undefined || this.deleted.has(messageId)) return Promise.resolve("missing");
    post.content = content;
    this.textEdits.push({ messageId, content });
    return Promise.resolve("ok");
  }

  public pin(_channelId: string, messageId: string): Promise<void> {
    this.pinned.push(messageId);
    return Promise.resolve();
  }

  public live(channelId: string): Sent[] {
    return this.sent.filter((message) => message.channelId === channelId && !message.removed && !this.deleted.has(message.messageId));
  }
}
