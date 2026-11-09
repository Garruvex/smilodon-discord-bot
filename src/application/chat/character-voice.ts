import type { ExampleExchange } from "./example-exchange.js";
import type { ChatResponse } from "./chat-provider.js";

export interface CharacterStyleProfile { maxChars: number; typicalChars: number; emojiRate: number; openers: string[] }
export function deriveStyleProfile(examples: readonly ExampleExchange[]): CharacterStyleProfile {
  const replies = examples.map((example) => example.character).filter(Boolean);
  const sizes = replies.map((reply) => reply.length).sort((a, b) => a - b);
  return { typicalChars: sizes[Math.floor(sizes.length / 2)] ?? 100, maxChars: Math.max(200, (sizes[Math.floor(sizes.length * 0.9)] ?? 250) * 2),
    emojiRate: replies.length ? replies.filter((reply) => /\p{Extended_Pictographic}/u.test(reply)).length / replies.length : 0,
    openers: [...new Set(replies.map((reply) => reply.split(/[\s，,。.!！]/u)[0] ?? ""))].filter(Boolean).slice(0, 12) };
}
export function voiceViolations(text: string, profile: CharacterStyleProfile, substantive: boolean): readonly string[] {
  const flags: string[] = [];
  if (!substantive && /^(?:\s*#{1,6}\s|\s*[-*+]\s|\s*\d+[.)]\s)/mu.test(text)) flags.push("markdown");
  if (/great question|as an ai|i hope this helps|how can i assist|很好的問題|希望這對你有幫助|お役に立てれば/iu.test(text)) flags.push("assistant_phrase");
  if (!substantive && text.length > profile.maxChars) flags.push("length");
  return flags;
}
export function trimVoice(text: string): string {
  return text.replace(/^(?:great question[!.]?|很好的問題[！!。]?)[ \n]*/iu, "")
    .replace(/(?:i hope this helps[!.]?|希望這對你有幫助[！!。]?)\s*$/iu, "").trim();
}
export function shapeMessages(reply: ChatResponse, maxMessages: number, maxDelayMs: number): ChatResponse {
  const parts = reply.text.split(/\n\s*\n/u).filter(Boolean);
  if (parts.length < 2 || maxMessages <= 1) return reply;
  const chunks = [...parts.slice(0, maxMessages - 1), parts.slice(maxMessages - 1).join("\n\n")];
  return { ...reply, characterMessages: chunks, characterDelayMs: Math.min(maxDelayMs, reply.text.length * 8) };
}
