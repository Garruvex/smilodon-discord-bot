// Exhaustiveness guard for closed unions: a missing case is a compile error,
// and a value that slips past the types at runtime fails loudly.
export function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${JSON.stringify(value)}`);
}
