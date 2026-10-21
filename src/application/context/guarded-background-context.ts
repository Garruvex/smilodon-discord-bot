import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import type { ChannelHistoryMessage, ChannelHistoryReader } from "./channel-history-reader.js";

const registered = new WeakSet<object>();
export type BackgroundModelPurpose = "summary" | "memory_extraction";
export type BackgroundValidationStatus = "current" | "changed" | "deadline";

// A bounded source snapshot, not a caller-supplied `filtered: true` assertion.
// Transport authorization remains responsible for fresh source/member reads.
export class GuardedBackgroundContext {
  public readonly messages: readonly Readonly<ChannelHistoryMessage>[];
  private closed = false;
  private passes = 0;
  private constructor(public readonly purpose: BackgroundModelPurpose, messages: readonly ChannelHistoryMessage[],
    private readonly reader: ChannelHistoryReader, private readonly policyCurrent: () => boolean | Promise<boolean>,
    private readonly report?: (status: BackgroundValidationStatus) => void) {
    this.messages = Object.freeze(messages.map((message) => Object.freeze({ ...message })));
    Object.defineProperty(this, "messages", { writable: false, configurable: false });
    Object.defineProperty(this, "purpose", { writable: false, configurable: false });
    registered.add(this);
  }

  public static async open(purpose: BackgroundModelPurpose, messages: readonly ChannelHistoryMessage[], reader: ChannelHistoryReader,
    policyCurrent: () => boolean | Promise<boolean>, report?: (status: BackgroundValidationStatus) => void): Promise<GuardedBackgroundContext> {
    const first = messages[0];
    if (!first || messages.length > 500 || messages.reduce((sum, message) => sum + message.content.length, 0) > 200_000 ||
        new Set(messages.map((message) => message.id)).size !== messages.length || messages.some((message) =>
          message.guildId !== first.guildId || message.channelId !== first.channelId || !message.content || !message.authorId || !message.id)) throw new SocialOutputSuppressed();
    const context = new GuardedBackgroundContext(purpose, messages, reader, policyCurrent, report);
    await context.check(); return context;
  }

  public async check(): Promise<void> {
    if (!registered.has(this) || this.closed || ++this.passes > 16) throw new SocialOutputSuppressed();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController(); let status: BackgroundValidationStatus = "changed";
    try {
      const valid = await Promise.race([
        (async (): Promise<boolean> => await this.policyCurrent() && !!this.reader.validateBatch && await this.reader.validateBatch(this.messages, controller.signal) && await this.policyCurrent())(),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => { status = "deadline"; controller.abort(); resolve(false); }, 8000); }),
      ]);
      if (!valid) throw new SocialOutputSuppressed();
      status = "current";
    } catch (error) { this.closed = true; throw error; }
    finally { if (timer) clearTimeout(timer); this.report?.(status); }
  }
}

export function isBackgroundContext(value: unknown, purpose: BackgroundModelPurpose): value is GuardedBackgroundContext {
  return !!value && typeof value === "object" && registered.has(value) && (value as GuardedBackgroundContext).purpose === purpose;
}
