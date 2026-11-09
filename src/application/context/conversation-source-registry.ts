import type { GuardedContextPort } from "../chat/guarded-conversation-context.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";

const sources = new WeakSet<object>();
// Import authority is restricted to reviewed source adapters by architecture
// checks. Raw objects and spread copies do not acquire source authority.
export function registerConversationSource(port: GuardedContextPort): GuardedContextPort {
  sources.add(port); return port;
}
export function isConversationSource(port: unknown): port is GuardedContextPort {
  return !!port && typeof port === "object" && sources.has(port);
}
export function extendConversationSource(port: GuardedContextPort, extension: Pick<GuardedContextPort, "resource" | "turnSignal">): GuardedContextPort {
  if (!isConversationSource(port)) throw new SocialOutputSuppressed();
  return registerConversationSource({ ...port, ...(extension.resource ? { resource: extension.resource } : {}),
    ...(extension.turnSignal ? { turnSignal: extension.turnSignal } : {}) });
}
