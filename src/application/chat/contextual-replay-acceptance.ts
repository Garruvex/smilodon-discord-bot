export interface ReplayAcceptanceResult {
  status: string; durationMs: number; expectedMeaning: boolean | null;
  policy: { textPolicyMet: boolean; requiredReplyMet: boolean } | null;
}
// Declared before the revision-3 fixture results. These gates cannot be passed
// by schema validity or correct abstention alone. Cost and live delivery need
// separate evidence; a synthetic preflight pass never authorizes deployment.
export const contextualReplayThresholds = Object.freeze({ minimumCases: 200, validity: 0.99, meaning: 0.95,
  maxTextViolations: 0, maxRequiredReplyMisses: 1, p95DecisionMs: 12000 });
export function contextualReplayAcceptance(results: readonly ReplayAcceptanceResult[]): {
  sufficientCases: boolean; validity: boolean; meaning: boolean; interruption: boolean; requiredReplies: boolean; latency: boolean; passed: boolean;
} {
  const total = results.length;
  const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
  const sufficientCases = total >= contextualReplayThresholds.minimumCases;
  const validity = total > 0 && results.filter((result) => result.status === "valid").length / total >= contextualReplayThresholds.validity;
  const meaning = total > 0 && results.filter((result) => result.expectedMeaning === true).length / total >= contextualReplayThresholds.meaning;
  const measured = total > 0 && results.every((result) => result.policy !== null);
  const interruption = measured && results.filter((result) => result.policy?.textPolicyMet === false).length <= contextualReplayThresholds.maxTextViolations;
  const requiredReplies = measured && results.filter((result) => result.policy?.requiredReplyMet === false).length <= contextualReplayThresholds.maxRequiredReplyMisses;
  const latency = (durations[Math.min(total - 1, Math.floor(total * 0.95))] ?? Infinity) <= contextualReplayThresholds.p95DecisionMs;
  return { sufficientCases, validity, meaning, interruption, requiredReplies, latency,
    passed: sufficientCases && validity && meaning && interruption && requiredReplies && latency };
}
