import { z } from "zod";

import { ChatProviderError } from "../../../application/chat/chat-provider.js";

const errorResponseSchema = z.object({
  error: z.object({ code: z.string().nullable().optional(), type: z.string().optional() }),
});

// Turns a failed HTTP response into the ChatProviderError the shared
// ModelFallbackChain understands (429 moves on to the next model).
export async function providerError(response: Response): Promise<ChatProviderError> {
  const body: unknown = await response.json().catch(() => null);
  const parsed = errorResponseSchema.safeParse(body);
  const code = parsed.success ? (parsed.data.error.code ?? parsed.data.error.type ?? null) : null;
  return new ChatProviderError(`Model provider returned HTTP ${response.status}${code ? ` (${code})` : ""}.`, response.status, code);
}
