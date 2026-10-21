import { isGuardedContext } from "../chat/guarded-conversation-context.js";
import { isBackgroundContext } from "../context/guarded-background-context.js";
import { SocialOutputSuppressed } from "../chat/message-origin-store.js";
import type { MemoryIngestInput } from "./memory.js";

export async function checkMemoryContext(context: MemoryIngestInput["context"]): Promise<void> {
  if (context === undefined) return; // Explicit legacy compatibility; never issues a complete claim proof.
  if (isGuardedContext(context)) { if (!await context.validate()) throw new SocialOutputSuppressed(); return; }
  if (isBackgroundContext(context, "summary") || isBackgroundContext(context, "memory_extraction")) { await context.check(); return; }
  throw new SocialOutputSuppressed();
}
