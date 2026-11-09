// drizzle-kit can split a SQL expression at its comma and quote each part as
// an identifier. Normalize this known emitted form only; ordinary identifiers
// and already valid expression indexes are left alone.
export function normalizeSqliteMigration(source: string): string {
  return source.replace(/`coalesce\("([a-z_]+)"`,` ''\)`/gu, (_match, column: string) => `coalesce(\`${column}\`, '')`);
}
