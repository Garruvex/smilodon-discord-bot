import type { CampaignMessageGateway } from "../../../../src/infrastructure/discord/campaign/campaign-message-gateway.js";
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
    const message = this.sent.find((candidate) => candidate.messageId === messageId);
    if (message === undefined || this.deleted.has(messageId)) return Promise.resolve("missing");
    message.payload = payload;
    this.edits.push(messageId);
    return Promise.resolve("ok");
  }

  public remove(_channelId: string, messageId: string): Promise<void> {
    const message = this.sent.find((candidate) => candidate.messageId === messageId);
    if (message !== undefined) message.removed = true;
    return Promise.resolve();
  }

  public readonly posts: { channelId: string; content: string; order: number }[] = [];

  public post(channelId: string, content: string): Promise<string> {
    this.next += 1;
    this.posts.push({ channelId, content, order: this.next });
    return Promise.resolve(`p${this.next}`);
  }

  public pin(_channelId: string, messageId: string): Promise<void> {
    this.pinned.push(messageId);
    return Promise.resolve();
  }

  public live(channelId: string): Sent[] {
    return this.sent.filter((message) => message.channelId === channelId && !message.removed && !this.deleted.has(message.messageId));
  }
}

