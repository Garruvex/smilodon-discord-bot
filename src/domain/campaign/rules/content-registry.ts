import type { Capability } from "./capabilities.js";
import {
  referencedContent,
  requiredCapabilities,
  type ContentDefinition,
  type DefinitionOf,
} from "./content-definitions.js";
import { parseContentId, type ContentId, type ContentKind } from "./content-id.js";

// Display names for one language, keyed by content ID. Lives with the i18n
// messages; the registry only checks that it is complete.
export interface Glossary {
  readonly language: string;
  readonly names: Readonly<Record<string, string>>;
}

export interface ContentBuildOptions {
  readonly capabilities: ReadonlySet<Capability>;
  readonly glossaries: readonly Glossary[];
}

// Immutable, validated content for one ruleset version. The only way to get
// one is ContentRegistryBuilder.build().
export interface SealedContent {
  readonly rulesetId: string;
  readonly version: string;
  get<K extends ContentKind>(id: ContentId<K>): DefinitionOf<K>;
  find(id: string): ContentDefinition | undefined;
  all<K extends ContentKind>(kind: K): readonly DefinitionOf<K>[];
}

export class ContentValidationError extends Error {
  public constructor(
    rulesetId: string,
    public readonly problems: readonly string[],
  ) {
    super(`Ruleset "${rulesetId}" failed validation:\n- ${problems.join("\n- ")}`);
    this.name = "ContentValidationError";
  }
}

export class ContentRegistryBuilder {
  private readonly definitions: ContentDefinition[] = [];

  public constructor(
    private readonly rulesetId: string,
    private readonly version: string,
  ) {}

  public add(definitions: readonly ContentDefinition[]): this {
    this.definitions.push(...definitions);
    return this;
  }

  // Validates everything and reports every problem at once, so fixing
  // content is one pass rather than one error per boot.
  public build(options: ContentBuildOptions): SealedContent {
    const problems: string[] = [];
    const byId = new Map<string, ContentDefinition>();

    for (const definition of this.definitions) {
      const parsed = parseContentId(definition.id);
      if (!parsed) {
        problems.push(`${definition.id}: not a valid content ID.`);
      } else if (parsed.kind !== definition.kind) {
        problems.push(`${definition.id}: ID prefix does not match kind "${definition.kind}".`);
      }
      if (byId.has(definition.id)) {
        problems.push(`${definition.id}: defined more than once.`);
        continue;
      }
      byId.set(definition.id, definition);
    }

    for (const definition of byId.values()) {
      problems.push(...this.checkDefinition(definition, byId, options.capabilities));
    }
    problems.push(...checkGlossaries(byId, options.glossaries));

    if (problems.length > 0) throw new ContentValidationError(this.rulesetId, problems);
    return seal(this.rulesetId, this.version, byId);
  }

  private checkDefinition(
    definition: ContentDefinition,
    byId: ReadonlyMap<string, ContentDefinition>,
    capabilities: ReadonlySet<Capability>,
  ): string[] {
    const problems: string[] = [];
    if (definition.source.trim().length === 0) {
      problems.push(`${definition.id}: missing source attribution.`);
    }

    let required: ReadonlySet<Capability>;
    let references: readonly ContentId[];
    try {
      required = requiredCapabilities(definition);
      references = referencedContent(definition);
    } catch (error) {
      // A spell plan that throws at some slot level is broken content.
      return [...problems, `${definition.id}: definition could not be evaluated (${describe(error)}).`];
    }

    for (const capability of required) {
      if (!capabilities.has(capability)) {
        problems.push(`${definition.id}: requires engine capability "${capability}", which is not available.`);
      }
    }
    for (const reference of new Set(references)) {
      const target = byId.get(reference);
      if (!target) {
        problems.push(`${definition.id}: references missing content "${reference}".`);
      } else if (target.kind !== parseContentId(reference)?.kind) {
        problems.push(`${definition.id}: reference "${reference}" resolves to a ${target.kind}.`);
      }
    }
    return problems;
  }
}

function checkGlossaries(byId: ReadonlyMap<string, ContentDefinition>, glossaries: readonly Glossary[]): string[] {
  const problems: string[] = [];
  for (const glossary of glossaries) {
    for (const id of byId.keys()) {
      const name = glossary.names[id];
      if (name === undefined || name.trim().length === 0) {
        problems.push(`${id}: no ${glossary.language} display name.`);
      }
    }
    for (const id of Object.keys(glossary.names)) {
      if (!byId.has(id)) problems.push(`${glossary.language} glossary names unknown content "${id}".`);
    }
  }
  return problems;
}

function seal(rulesetId: string, version: string, byId: ReadonlyMap<string, ContentDefinition>): SealedContent {
  const entries = new Map<string, ContentDefinition>();
  for (const [id, definition] of byId) entries.set(id, deepFreeze(definition));

  return Object.freeze({
    rulesetId,
    version,
    get<K extends ContentKind>(id: ContentId<K>): DefinitionOf<K> {
      const definition = entries.get(id);
      if (!definition) throw new Error(`Ruleset "${rulesetId}" has no content "${id}".`);
      return definition as DefinitionOf<K>;
    },
    find(id: string): ContentDefinition | undefined {
      return entries.get(id);
    },
    all<K extends ContentKind>(kind: K): readonly DefinitionOf<K>[] {
      return [...entries.values()].filter((definition): definition is DefinitionOf<K> => definition.kind === kind);
    },
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
