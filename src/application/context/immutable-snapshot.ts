// Source projections are plain structured data. Copy before freezing so the
// transport may continue refreshing its own objects without changing a lease.
export function immutableSnapshot<T>(value: T): T {
  const copy: T = structuredClone(value);
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(copy); return copy;
}
