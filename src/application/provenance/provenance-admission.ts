import {
  defaultProvenanceTraversalBudget,
  type ProvenanceAdmission, type ProvenanceGraphReader, type ProvenanceMessageSource, type ProvenanceRejection, type ProvenanceRevisionKind,
} from "./provenance-graph.js";

// Which reader decides provenance for one artifact kind.
// v1: the flattened proof alone. This is also the rollback setting: an output that exists only in the
//     graph has no v1 proof, so a v1 reader never sees it.
// shadow: v1 decides; the graph is checked beside it and disagreements are counted.
// v2: the graph decides for migrated items. An item with no graph revision keeps its complete v1 path.
export type ProvenanceReaderMode = "v1" | "shadow" | "v2";

export const provenanceReaderKinds = ["reply_part", "session", "claim", "alias", "relation", "character_state"] as const;
export type ProvenanceReaderKind = typeof provenanceReaderKinds[number];

export interface ProvenanceCandidate {
  // The graph artifact this candidate is: its kind and ID there.
  graphKind: ProvenanceRevisionKind;
  artifactId: string;
  // The v1 reader's decision for the same candidate version, audience and policy.
  v1: boolean;
  // The candidate's output. When given, only a current graph revision bound to this output admits it.
  outputHash?: string;
}

// Counts only: never IDs or text.
export interface ProvenanceComparison {
  kind: ProvenanceReaderKind;
  mode: ProvenanceReaderMode;
  candidates: number;
  agreed: number;
  newlyAdmitted: number;
  newlyRejected: number;
  unmigrated: number;
  reasons: readonly ProvenanceRejection[];
}

export interface ProvenanceAdmissionScope { guildId: string; channelId: string; audienceUserId: string | null }

// source "graph": the graph decided, and messages lists the Discord messages the candidate reaches.
// source "v1": the v1 decision stands (v1 or shadow mode, or an item the graph does not have).
export interface ProvenanceDecision { admitted: boolean; source: "v1" | "graph"; messages: readonly ProvenanceMessageSource[] }

export class ProvenanceAdmissionGate {
  public constructor(
    private readonly graph: ProvenanceGraphReader,
    private readonly modes: (kind: ProvenanceReaderKind) => ProvenanceReaderMode,
    private readonly report: (comparison: ProvenanceComparison) => void = () => undefined,
    private readonly budget = defaultProvenanceTraversalBudget,
  ) {}

  public mode(kind: ProvenanceReaderKind): ProvenanceReaderMode { return this.modes(kind); }

  // The admission decision for each candidate, in input order. A failed graph check fails closed in v2
  // and leaves v1's decision in shadow mode.
  public async decide(kind: ProvenanceReaderKind, scope: ProvenanceAdmissionScope, candidates: readonly ProvenanceCandidate[]): Promise<boolean[]> {
    return (await this.decideDetailed(kind, scope, candidates)).map((decision) => decision.admitted);
  }

  public async decideDetailed(kind: ProvenanceReaderKind, scope: ProvenanceAdmissionScope, candidates: readonly ProvenanceCandidate[]): Promise<ProvenanceDecision[]> {
    const mode = this.modes(kind);
    const fromV1 = (): ProvenanceDecision[] => candidates.map((candidate) => ({ admitted: candidate.v1, source: "v1", messages: [] }));
    if (mode === "v1" || !candidates.length) return fromV1();
    let v2: (boolean | null)[]; const reasons = new Set<ProvenanceRejection>();
    const revisionOf: (string | undefined)[] = []; let ancestors: ReadonlyMap<string, readonly ProvenanceMessageSource[]> = new Map();
    try {
      const revisions = new Map<string, string>(); const outputs = new Map<string, string | null>();
      for (const graphKind of new Set(candidates.map((candidate) => candidate.graphKind))) {
        const found = await this.graph.currentOutputs(scope.guildId, scope.channelId, graphKind,
          candidates.filter((candidate) => candidate.graphKind === graphKind).map((candidate) => candidate.artifactId));
        for (const [artifactId, current] of found) { revisions.set(`${graphKind}:${artifactId}`, current.revisionId); outputs.set(current.revisionId, current.outputHash); }
      }
      const admissions = revisions.size ? await this.graph.checkAncestry({ ...scope, revisionIds: [...revisions.values()], budget: this.budget }) : new Map<string, ProvenanceAdmission>();
      v2 = candidates.map((candidate, index) => {
        const revisionId = revisions.get(`${candidate.graphKind}:${candidate.artifactId}`);
        revisionOf[index] = revisionId;
        if (!revisionId) return null;
        // A newer version superseded this output: the graph knows the artifact, and this copy is stale.
        if (candidate.outputHash !== undefined && outputs.get(revisionId) !== candidate.outputHash) { reasons.add("stale"); return false; }
        const admission = admissions.get(revisionId);
        if (!admission?.admitted) for (const reason of admission?.reasons ?? ["missing"] as const) reasons.add(reason);
        return admission?.admitted === true;
      });
      if (mode === "v2") {
        const admitted = revisionOf.filter((revisionId, index): revisionId is string => !!revisionId && v2[index] === true);
        if (admitted.length) ancestors = await this.graph.ancestorMessages(scope.guildId, scope.channelId, admitted);
      }
    } catch {
      if (mode === "v2") return candidates.map(() => ({ admitted: false, source: "graph", messages: [] }));
      return fromV1();
    }
    const comparison: ProvenanceComparison = { kind, mode, candidates: candidates.length, agreed: 0, newlyAdmitted: 0, newlyRejected: 0, unmigrated: 0, reasons: [...reasons].sort() };
    candidates.forEach((candidate, index) => {
      const graph = v2[index];
      if (graph === null || graph === undefined) comparison.unmigrated++;
      else if (graph === candidate.v1) comparison.agreed++;
      else if (graph) comparison.newlyAdmitted++;
      else comparison.newlyRejected++;
    });
    this.report(comparison);
    return candidates.map((candidate, index): ProvenanceDecision => {
      const graph = v2[index];
      if (mode === "shadow" || graph === null || graph === undefined) return { admitted: candidate.v1, source: "v1", messages: [] };
      return { admitted: graph, source: "graph", messages: graph ? ancestors.get(revisionOf[index]!) ?? [] : [] };
    });
  }
}

// "reply_part=shadow,claim=v2" → modes; anything unnamed or malformed stays v1.
export function parseProvenanceReaderModes(value: string | undefined): (kind: ProvenanceReaderKind) => ProvenanceReaderMode {
  const modes = new Map<string, ProvenanceReaderMode>();
  for (const entry of (value ?? "").split(",")) {
    const [kind, mode] = entry.split("=").map((part) => part.trim());
    if (kind && (provenanceReaderKinds as readonly string[]).includes(kind) && (mode === "v1" || mode === "shadow" || mode === "v2")) modes.set(kind, mode);
  }
  return (kind) => modes.get(kind) ?? "v1";
}
