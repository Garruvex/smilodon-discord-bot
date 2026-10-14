import type { Memory } from "./memory.js";

export interface ObservedSubjectName { value: string; observedAt: number }
export function aliasQueryTokens(message: string): string[] {
  const normalized = message.slice(0, 1000).toLowerCase();
  const words = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(normalized)]
    .filter((part) => part.isWordLike).map((part) => part.segment);
  // Short Han labels require an explicit standalone token. Segmentation
  // can split a compound such as 苹果汁 into 苹果 + 汁; that is not proof
  // the two-character member label 苹果 was addressed.
  const tokens = new Set(words.filter((word) => word.length >= 2 && !/^\p{Script=Han}{2}$/u.test(word)));
  for (const token of normalized.match(/[\p{L}\p{N}_.-]+/gu) ?? []) if (token.length >= 2) tokens.add(token);
  for (const match of normalized.matchAll(/[\p{Script=Latin}\d_.-]+(?: +[\p{Script=Latin}\d_.-]+){1,2}/gu)) tokens.add(match[0]);
  return [...tokens].slice(0, 96);
}
export function observedSubjectNames(memory: Pick<Memory, "structuredValue">): ObservedSubjectName[] {
  if (!memory.structuredValue || typeof memory.structuredValue !== "object" || !("observedSubjectNames" in memory.structuredValue)) return [];
  const values: unknown = memory.structuredValue.observedSubjectNames;
  if (!Array.isArray(values)) return [];
  return values.filter((item: unknown): item is ObservedSubjectName => typeof item === "object" && item !== null &&
    "value" in item && typeof item.value === "string" && "observedAt" in item && typeof item.observedAt === "number").slice(0, 16);
}

export function observedAliasCandidates(memories: readonly Memory[], message: string): { alias: string; subjectIds: string[] }[] {
  return groupObservedAliasRows(memories.filter((memory) => memory.subjectType === "member").flatMap((memory) =>
    observedSubjectNames(memory).map((name) => ({ alias: name.value, subjectId: memory.subjectId }))), message);
}

export function groupObservedAliasRows(rows: readonly { alias: string; subjectId: string }[], message: string): { alias: string; subjectIds: string[] }[] {
  const tokens = new Set(aliasQueryTokens(message));
  const aliases = new Map<string, Set<string>>();
  for (const row of rows) {
      const alias = row.alias.toLowerCase();
      if (alias.length < 2 || !tokens.has(alias)) continue;
      const subjects = aliases.get(alias) ?? new Set<string>();
      subjects.add(row.subjectId); aliases.set(alias, subjects);
  }
  return [...aliases.entries()].slice(0, 32).map(([alias, subjects]) => ({ alias, subjectIds: [...subjects] }));
}
