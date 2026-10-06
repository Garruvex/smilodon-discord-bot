// A warlock's choices: the Eldritch Invocations they hold and their Pact Boon. They are features on the sheet, like a
// Fighting Style, and may be swapped while the hero levels up.
export const invocationOptions = [
  "feature:agonizing-blast",
  "feature:armor-of-shadows",
  "feature:fiendish-vigor",
  "feature:repelling-blast",
  "feature:devils-sight",
  "feature:thief-of-five-fates",
  "feature:eldritch-sight",
  "feature:beast-speech",
  "feature:mask-of-many-faces",
  "feature:misty-visions",
] as const;
export type InvocationId = (typeof invocationOptions)[number];

export const pactBoons = ["feature:pact-of-the-chain", "feature:pact-of-the-blade", "feature:pact-of-the-tome"] as const;
export type PactBoonId = (typeof pactBoons)[number];

export const isInvocation = (id: string): id is InvocationId => (invocationOptions as readonly string[]).includes(id);
export const isPactBoon = (id: string): id is PactBoonId => (pactBoons as readonly string[]).includes(id);

// SRD 5.1: two invocations at level 2, then one more at levels 5, 7, 9, 12, 15 and 18.
export function invocationSlots(warlockLevel: number): number {
  return [2, 5, 7, 9, 12, 15, 18].filter((level) => warlockLevel >= level).length + (warlockLevel >= 2 ? 1 : 0);
}

// The pact boon comes with level 3.
export const pactBoonLevel = 3;

export const heldInvocations = (features: readonly string[]): readonly InvocationId[] => features.filter(isInvocation);
export const heldPactBoon = (features: readonly string[]): PactBoonId | null => features.find(isPactBoon) ?? null;

// The feature list with the invocations and the boon replaced by the chosen ones (each left alone when not named).
export function withWarlockChoices<F extends string>(features: readonly F[], invocations: readonly InvocationId[] | undefined, boon: PactBoonId | undefined): readonly F[] {
  const kept = features.filter((feature) => !(invocations !== undefined && isInvocation(feature)) && !(boon !== undefined && isPactBoon(feature)));
  return [...kept, ...((invocations ?? []) as readonly string[] as readonly F[]), ...(boon === undefined ? [] : [boon as string as F])];
}
