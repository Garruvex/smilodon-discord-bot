import { emitChatDiagnostic, type DiagnosticLogger } from "../diagnostics/chat-diagnostics.js";

// These events describe guard rejection, not a provider/network attempt.
// Never include arguments, prompts, error messages, text or result bodies.
export async function checkModelAdmission<T>(logger: DiagnosticLogger | null, purpose: string, phase: "approval" | "source" | "result", check: () => T | Promise<T>): Promise<T> {
  try { return await check(); }
  catch (error) { emitChatDiagnostic(logger, { event: "model.gateway.rejected", purpose, phase }); throw error; }
}
