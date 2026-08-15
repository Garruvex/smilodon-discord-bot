import type { ComponentHandler } from "./component-handler.js";

export class ComponentRegistry {
  private readonly handlers = new Map<string, ComponentHandler>();

  public register(handler: ComponentHandler): void {
    const prefix = handler.customIdPrefix.trim();
    if (prefix.length === 0 || prefix.includes(":")) {
      throw new Error(`Invalid component prefix: "${handler.customIdPrefix}".`);
    }

    if (this.handlers.has(prefix)) {
      throw new Error(`Component prefix "${prefix}" is already registered.`);
    }

    this.handlers.set(prefix, handler);
  }

  public find(customId: string): ComponentHandler | null {
    const [prefix] = customId.split(":", 1);
    return prefix ? (this.handlers.get(prefix) ?? null) : null;
  }
}

