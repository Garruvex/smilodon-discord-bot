export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  // True while a task for this key is running or queued behind one that is.
  public isBusy(key: string): boolean {
    return this.tails.has(key);
  }

  public async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
