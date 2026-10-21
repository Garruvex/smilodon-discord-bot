import type { MemoryIngestInput, MemoryRelationIngestInput } from "../../src/application/memory/memory.js";
import { approveMemoryIngest, approveRelationIngest } from "../../src/application/context/approved-memory-ingest.js";

// Explicit synthetic producer premise. Guarded fixture statements represent
// model output from their admitted source context. No evidence, quotations or
// privacy rights are invented; context-free legacy seeds remain unproven.
export function fixtureMemoryIngest(input: MemoryIngestInput): MemoryIngestInput {
  return input.context === undefined ? input : approveMemoryIngest(input);
}
export function fixtureRelationIngest(input: MemoryRelationIngestInput): MemoryRelationIngestInput {
  return input.context === undefined ? input : approveRelationIngest(input);
}
