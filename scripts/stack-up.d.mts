export function stackUp(run?: (command: string, args: readonly string[]) => {
  status: number | null; error?: Error | undefined; stdout?: string | undefined;
}): void;
