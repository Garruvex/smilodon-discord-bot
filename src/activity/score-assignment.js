export const standardScores = [15, 14, 13, 12, 10, 8];

export function availableScores(assignments, ability) {
  const used = new Set(Object.entries(assignments).filter(([key]) => key !== ability).map(([, score]) => score));
  return standardScores.filter((score) => !used.has(score));
}

export function assignScore(assignments, ability, score) {
  const next = { ...assignments };
  if (score === null) { next[ability] = null; return next; }
  if (!standardScores.includes(score) || !availableScores(assignments, ability).includes(score)) return next;
  next[ability] = score;
  return next;
}
