import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import {
  bm25WeightGrid,
  calibrateBm25Weights,
  type RetrievalMetrics,
} from "../application/chat/memory-relevance-calibration.js";
import { defaultBm25ScoreWeights } from "../application/chat/memory-relevance.js";

const candidateSchema = z.object({
  id: z.string().min(1),
  subjectId: z.string(),
  topic: z.string(),
  slot: z.string(),
  statement: z.string(),
  updatedAt: z.number().finite(),
  serializedChars: z.number().int().positive().optional(),
  cosineSimilarity: z.number().min(0).max(1).optional(),
  relationBoost: z.number().nonnegative().optional(),
}).strict();

const evaluationCaseSchema = z.object({
  id: z.string().min(1),
  split: z.enum(["calibration", "validation"]),
  message: z.string(),
  recentHistory: z.array(z.string()).optional(),
  subjectIds: z.array(z.string()),
  now: z.number().finite(),
  candidates: z.array(candidateSchema).min(1),
  // Empty is a legitimate, important case: "none of these candidates are
  // actually relevant" — without it, the dataset structurally cannot
  // contain a false-positive-penalizing example (see evaluateBm25Weights'
  // precision calculation, which already handles relevant.size === 0).
  relevantIds: z.array(z.string()),
  maxResults: z.number().int().positive().optional(),
  maxSerializedChars: z.number().int().positive().optional(),
  requireTopicalMatch: z.boolean().optional(),
}).strict().superRefine((evaluationCase, context) => {
  const candidateIds = new Set(evaluationCase.candidates.map((candidate) => candidate.id));
  for (const relevantId of evaluationCase.relevantIds) {
    if (!candidateIds.has(relevantId)) {
      context.addIssue({
        code: "custom",
        message: `relevantIds contains unknown candidate "${relevantId}"`,
        path: ["relevantIds"],
      });
    }
  }
});

const datasetSchema = z.array(evaluationCaseSchema).min(1);

function formatMetrics(metrics: RetrievalMetrics | null): string {
  if (!metrics) return "n/a";
  return [metrics.objective, metrics.recall, metrics.precision,
    metrics.meanReciprocalRank, metrics.normalizedDiscountedCumulativeGain]
    .map((value) => value.toFixed(3))
    .join("  ");
}

const datasetPath = resolve(process.argv[2] ?? "config/memory-relevance-eval.example.json");
const parsed: unknown = JSON.parse(readFileSync(datasetPath, "utf8"));
const cases = datasetSchema.parse(parsed);
const grid = bm25WeightGrid({
  subjectBoosts: [0, 0.5, 1, 2, 3, 4, 6],
  maxRecencyBoosts: [0, 0.25, 0.5, 1, 2, 3],
  recencyWindowDays: [7, 14, 30, 60, 90],
});
const results = calibrateBm25Weights(cases, grid);
const baseline = calibrateBm25Weights(cases, [defaultBm25ScoreWeights])[0]!;

process.stdout.write(`Dataset: ${datasetPath}\n`);
process.stdout.write(`Cases: ${cases.length}; configurations: ${grid.length}\n`);
process.stdout.write("weights (subject, recency, days)  split         obj    recall precision MRR    nDCG\n");
process.stdout.write(`${"3, 2, 30 (current default)".padEnd(34)}calibration   ${formatMetrics(baseline.calibration)}\n`);
process.stdout.write(`${"".padEnd(34)}validation    ${formatMetrics(baseline.validation)}\n\n`);
for (const result of results.slice(0, 10)) {
  const days = result.weights.recencyWindowMs / (24 * 60 * 60 * 1_000);
  const weights = `${result.weights.subjectBoost}, ${result.weights.maxRecencyBoost}, ${days}`.padEnd(34);
  process.stdout.write(`${weights}calibration   ${formatMetrics(result.calibration)}\n`);
  process.stdout.write(`${"".padEnd(34)}validation    ${formatMetrics(result.validation)}\n`);
}
process.stdout.write("\nSelect weights using calibration score; use validation only to estimate generalization.\n");
process.stdout.write("The bundled dataset is illustrative. Replace it with reviewed, representative recall cases before changing production defaults.\n");
