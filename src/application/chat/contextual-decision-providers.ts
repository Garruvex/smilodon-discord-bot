import type { StructuredCharacterProvider } from "./chat-provider.js";

export interface ContextualDecisionProviders {
  primary: StructuredCharacterProvider | null; fallback: StructuredCharacterProvider | null;
  source: "dedicated" | "reply" | "utility" | "unavailable";
}
// Contextual interpretation uses reply-model language capability unless an
// operator configures a dedicated model. Utility is not an automatic downgrade
// after a reply-model failure. Every selected source needs per-instance replay.
export function contextualDecisionProviders(dedicated: StructuredCharacterProvider | null, reply: StructuredCharacterProvider | null,
  utility: StructuredCharacterProvider | null): ContextualDecisionProviders {
  const primary = dedicated ?? reply ?? utility;
  return { primary, fallback: dedicated && reply !== dedicated ? reply : null,
    source: dedicated ? "dedicated" : reply ? "reply" : utility ? "utility" : "unavailable" };
}
