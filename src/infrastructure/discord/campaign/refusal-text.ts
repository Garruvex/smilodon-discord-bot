import type { Texts } from "../../../application/i18n/texts.js";

// The private explanation for a refused control. The code is either a lobby or
// service refusal or an engine rejection; anything without its own wording
// gets the general one, never raw text from the engine.
export function refusalText(text: Texts, reason: string): string {
  const messages: Readonly<Record<string, string>> = text.campaign.refusal;
  return messages[reason] ?? text.campaign.refusal.generic;
}
