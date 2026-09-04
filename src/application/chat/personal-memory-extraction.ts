import { z } from "zod";

import { memoryTopicIds } from "./chat-memory-policy.js";
import { ChatProviderError } from "./chat-provider.js";

// Deliberately narrower than chatModelOutputSchema's userMemoryActions: no
// subjectUserId field — the app always supplies speaker.id itself (see
// ChatConversationService.extractPersonalMemories), so the model can never
// redirect a write to an arbitrary/invented id. That alone isn't enough,
// though: it stops writes to someone else's profile, but not the model
// mislabeling a third-party fact ("Bob likes pizza") as if it were the
// speaker's own, since every action it emits ends up stamped with the
// speaker's id regardless. `aboutSpeaker` is the actual defense against
// that — the model must explicitly confirm each action is really about the
// speaker, and the app drops (never force-relabels) anything where it says
// otherwise, in ChatConversationService.extractPersonalMemories. A
// third-party claim belongs in guild knowledge, which this pass doesn't
// produce — see chatMemoryInstructions' own guidance on that split,
// followed by the main reply model, which has both action types available.
export const personalMemoryExtractionSchema = z.object({
  actions: z.array(z.object({
    action: z.enum(["upsert", "remove"]),
    aboutSpeaker: z.boolean(),
    // A verbatim (or near-verbatim) excerpt of USER MESSAGE that this
    // action is grounded in — checked by the app (see
    // ChatConversationService.extractPersonalMemories) as a literal
    // substring of the actual message text before the action is trusted at
    // all. This is a structural check against the assistant-reply-
    // hallucination vector specifically (a statement that traces back to
    // nothing the user actually said gets dropped, full stop, not merely
    // discouraged by instruction) — it is NOT a defense against
    // misattribution: a genuine third-party claim in the user's own
    // message ("Bob likes pizza") quotes just as validly as a real
    // self-report, so aboutSpeaker remains the only check for that.
    sourceQuote: z.string(),
    topic: z.string(),
    slot: z.string(),
    statement: z.string().nullable(),
  })).max(5),
});

export type PersonalMemoryExtraction = z.infer<typeof personalMemoryExtractionSchema>;

export const personalMemoryExtractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["actions"],
  properties: {
    actions: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["action", "aboutSpeaker", "sourceQuote", "topic", "slot", "statement"],
        properties: {
          action: { type: "string", enum: ["upsert", "remove"] },
          aboutSpeaker: { type: "boolean" },
          sourceQuote: { type: "string" },
          topic: { type: "string" },
          slot: { type: "string" },
          statement: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

const untrustedOpenTag = "<<<BEGIN-UNTRUSTED-DATA>>>";
const untrustedCloseTag = "<<<END-UNTRUSTED-DATA>>>";

function wrapUntrusted(text: string): string {
  const sanitized = text.replaceAll(untrustedOpenTag, "[tag]").replaceAll(untrustedCloseTag, "[tag]");
  return `${untrustedOpenTag}\n${sanitized}\n${untrustedCloseTag}`;
}

// The conversational reply model has every incentive to under-report memory
// actions — its prompt (chatMemoryInstructions) explicitly ends with "when
// uncertain, return no memory actions" so a marginal call doesn't derail the
// reply, and producing a reply is its primary job, extraction a secondary
// one it can silently skip under any pressure. This is a dedicated second
// pass, run after the reply is already delivered (see
// ChatConversationService.run), whose only job is deciding what from this
// exchange belongs in long-term memory about the SPEAKER — it has no reply
// to write and nothing to lose by extracting thoroughly.
//
// Evidence rule: only the USER MESSAGE is evidence of a fact about the
// speaker. The ASSISTANT REPLY is included purely so you understand what
// was already said — never extract something because the assistant
// asserted, guessed, or restated it. A reply like "you probably love jazz"
// must never become a memory unless the user's own message independently
// confirms or states it (a plain "yes"/agreement to a direct question the
// assistant asked is fine; the assistant inventing or assuming a fact is
// not).
const personalMemoryExtractionPreamble =
  `You are a dedicated memory-extraction pass, run after a conversational reply to this message has already been ` +
  `sent. You are not writing a reply and nothing you say here is shown to the user — your only job is deciding ` +
  `what from this one exchange belongs in long-term memory about the speaker (never anyone else — see below). A ` +
  `separate process already had a chance to propose memory actions and may have proposed some, none, or missed ` +
  `something; extract independently and thoroughly, as if this were the only chance to catch a durable fact. Err ` +
  `toward capturing a clear, compact, durable fact even if you're not certain it will matter later — ` +
  `under-extraction here has no recovery path, since the information disappears from memory entirely once this ` +
  `exchange scrolls out of recent history.\n\n` +
  `Evidence rule: only the USER MESSAGE is evidence of a fact about the speaker. The ASSISTANT REPLY is included ` +
  `purely so you understand what was already discussed — never extract something solely because the assistant ` +
  `asserted, guessed, or restated it back at the user. A reply like "you probably love jazz" must never become a ` +
  `memory unless the user's own message independently states or confirms it (a plain "yes" to a direct question ` +
  `the assistant asked is fine evidence; the assistant inventing or assuming a fact on its own is not). Every ` +
  `action also carries sourceQuote: a verbatim (or near-verbatim) excerpt copied from USER MESSAGE that grounds ` +
  `it — the app checks this is actually present in the message text and discards the action if it isn't, so an ` +
  `action grounded only in the assistant's reply (nothing in sourceQuote to copy) cannot pass through no matter ` +
  `what aboutSpeaker says.\n\n` +
  `Subject rule: this pass only ever writes about the speaker. If the user message states something about someone ` +
  `else instead (e.g. "Bob likes pizza"), do not output an action for it at all — that belongs to a different ` +
  `process this pass doesn't perform. Every action also carries its own aboutSpeaker field as an explicit ` +
  `self-check: set it to true only when you're confident the fact is genuinely about the speaker themselves, not ` +
  `someone they mentioned. The app will discard any action where aboutSpeaker is false, so when genuinely unsure ` +
  `whether a statement is about the speaker or someone else, set it to false rather than guessing true.\n\n` +
  `Use a stable topic from: ${memoryTopicIds.join(", ")}. Use a short lowercase semantic slot such as food.fruit, ` +
  `role.overwatch, or current.discord_bot. Use upsert for a new/corrected durable fact and remove only for an ` +
  `explicit forget/correction request. Do not store transcripts, jokes, temporary details, secrets, credentials, ` +
  `or sensitive financial/medical data. Return an empty actions array if nothing qualifies.`;

export function buildPersonalMemoryExtractionPrompt(
  userMessage: string,
  assistantReply: string,
  speaker: { id: string; displayName: string },
): string {
  return `${personalMemoryExtractionPreamble}\n\n` +
    `SPEAKER (display name untrusted, shown for context only): ${wrapUntrusted(speaker.displayName)}\n\n` +
    `USER MESSAGE (untrusted — the only evidence for any action)\n${wrapUntrusted(userMessage)}\n\n` +
    `ASSISTANT REPLY (untrusted, for context only — never evidence on its own)\n${wrapUntrusted(assistantReply)}`;
}

export function parsePersonalMemoryExtractionOutput(text: string): PersonalMemoryExtraction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ChatProviderError("The model returned a reply that was not valid JSON.", 502, "invalid_structured_output");
  }
  const result = personalMemoryExtractionSchema.safeParse(parsed);
  if (!result.success) {
    throw new ChatProviderError(
      "The model returned a reply that did not match the expected schema.",
      502,
      "invalid_structured_output",
    );
  }
  return result.data;
}
