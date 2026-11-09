export function contextualProposal(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { relationship: "followup", intent: "answer", action: "reply", referent: "context_linked", linkKey: "speaker_1", recipientEvidence: ["current"], recipientConfidence: 0.95,
    confidence: 0.95, opening: "clear", contribution: { text: "A specific answer", adds: "New information", label: "answer", motivation: 0.95 }, reaction: null, ...extra };
}
