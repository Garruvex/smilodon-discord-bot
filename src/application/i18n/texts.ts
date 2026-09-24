import type { Language } from "./language.js";
import { en, type TranslationCatalog } from "./messages/en.js";
import { ja } from "./messages/ja.js";
import { zhTW } from "./messages/zh-TW.js";

// One frozen object per language, built once at startup from the flat
// catalogs in ./messages:
//
//   const text = texts[profile.language];         // or context.text
//   text.music.panel.queue.title                   // "Queue"
//   text.music.panel.queue.footerCount({ count })  // "3 queued"
//
// A message without placeholders is a string; one with `{name}` placeholders
// is a function taking those values. English defines the shape; every other
// language has the same shape, with English filling in whatever it hasn't
// translated (or translated invalidly — see buildTexts).
//
// Pick the object per interaction or render (texts[profile.language]), never
// by mutating a shared one: many servers are served concurrently.

// ---------------------------------------------------------------------------
// Types: dotted keys + placeholders -> nested read-only object
// ---------------------------------------------------------------------------

// Same grammar as `placeholderPattern` below: `{` word characters `}`.
// (buildTexts rejects any other `{`/`}` in a message, so the two can't drift.)
type PlaceholderNames<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | PlaceholderNames<Rest>
  : never;

// A value a message inserts — a count, a title, a mention. Placeholder names
// can't say whether they're numbers or text, so both are accepted.
export type MessageParams<Name extends string> = { readonly [P in Name]: string | number };

type Message<S extends string> = [PlaceholderNames<S>] extends [never]
  ? string
  : (params: MessageParams<PlaceholderNames<S>>) => string;

type Head<Key extends string> = Key extends `${infer First}.${string}` ? First : Key;
type Tail<Key extends string, First extends string> = Key extends `${First}.${infer Rest}` ? Rest : never;

type TextTree<Messages extends Record<string, string>> = {
  readonly [First in Head<keyof Messages & string>]: First extends keyof Messages
    ? Message<Messages[First]>
    : TextTree<{ [Key in keyof Messages & string as Tail<Key, First>]: Messages[Key] }>;
};

export type Texts = TextTree<typeof en>;

// ---------------------------------------------------------------------------
// Runtime: validate, resolve fallbacks, compile, build, freeze
// ---------------------------------------------------------------------------

const placeholderPattern = /\{(\w+)\}/g;
const keySegmentPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reservedKeySegments = new Set(["__proto__", "constructor", "prototype"]);

type CompiledMessage = string | ((params: Readonly<Record<string, string | number>>) => string);
interface TextNode { [segment: string]: TextNode | CompiledMessage }

// A problem in a translation. The message falls back to English, so users
// still get a working reply; tests and `npm run i18n:coverage` surface these.
export interface CatalogIssue {
  language: string;
  key: string;
  problem: string;
}

// A problem in the English catalog itself. English is the required baseline,
// so this fails startup (and every test) rather than falling back.
export class CatalogError extends Error {
  public constructor(problems: readonly string[]) {
    super(`Invalid English message catalog:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    this.name = "CatalogError";
  }
}

export interface BuiltTexts<L extends string> {
  texts: Readonly<Record<L, unknown>>;
  issues: readonly CatalogIssue[];
  // Keys each language falls back to English for because it hasn't
  // translated them (not counting invalid translations — those are issues).
  untranslated: Readonly<Record<L, readonly string[]>>;
}

function placeholdersOf(message: string): Set<string> {
  return new Set([...message.matchAll(placeholderPattern)].map((match) => match[1]!));
}

function messageProblem(message: string): string | null {
  if (message.trim().length === 0) return "is blank";
  if (/[{}]/.test(message.replace(placeholderPattern, ""))) {
    return "has a `{` or `}` that isn't a `{name}` placeholder";
  }
  return null;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item));
}

// Splitting on the capturing pattern alternates literal text (even indexes)
// with placeholder names (odd). Values are joined in as-is — never re-scanned
// — so a track title containing `$&` or `{count}` is inserted literally.
function compile(message: string): CompiledMessage {
  const segments = message.split(/\{(\w+)\}/);
  if (segments.length === 1) return message;
  return (params) =>
    segments
      .map((segment, index) => {
        if (index % 2 === 0) return segment;
        const value = params[segment];
        return value === undefined ? `{${segment}}` : String(value);
      })
      .join("");
}

function keyProblem(key: string): string | null {
  const segments = key.split(".");
  if (segments.some((segment) => segment.length === 0)) return "has an empty path segment";
  const reserved = segments.find((segment) => reservedKeySegments.has(segment));
  if (reserved) return `uses the reserved name "${reserved}"`;
  const invalid = segments.find((segment) => !keySegmentPattern.test(segment));
  if (invalid) return `has the invalid path segment "${invalid}"`;
  return null;
}

// "a.b" alongside "a.b.c" would make `a.b` both a message and a group.
function collisionProblems(keys: readonly string[]): string[] {
  const all = new Set(keys);
  const problems: string[] = [];
  for (const key of keys) {
    const segments = key.split(".");
    for (let length = 1; length < segments.length; length += 1) {
      const prefix = segments.slice(0, length).join(".");
      if (all.has(prefix)) problems.push(`"${prefix}" is a message but "${key}" also uses it as a group`);
    }
  }
  return problems;
}

function place(root: TextNode, key: string, value: CompiledMessage): void {
  const segments = key.split(".");
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    const child = node[segment];
    if (child === undefined) {
      const created: TextNode = {};
      node[segment] = created;
      node = created;
    } else {
      node = child as TextNode;
    }
  }
  node[segments[segments.length - 1]!] = value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function buildTexts<L extends string>(
  english: Readonly<Record<string, string>>,
  translations: Readonly<Record<L, Readonly<Record<string, string | undefined>>>>,
): BuiltTexts<L> {
  const keys = Object.keys(english);

  const englishProblems: string[] = [];
  for (const key of keys) {
    const invalidKey = keyProblem(key);
    if (invalidKey) englishProblems.push(`key "${key}" ${invalidKey}`);
    const invalidMessage = messageProblem(english[key]!);
    if (invalidMessage) englishProblems.push(`"${key}" ${invalidMessage}`);
  }
  englishProblems.push(...collisionProblems(keys));
  if (englishProblems.length > 0) throw new CatalogError(englishProblems);

  const issues: CatalogIssue[] = [];
  const texts = {} as Record<L, unknown>;
  const untranslated = {} as Record<L, readonly string[]>;

  for (const language of Object.keys(translations) as L[]) {
    const catalog = translations[language];
    const missing: string[] = [];
    const root: TextNode = {};

    for (const key of Object.keys(catalog)) {
      if (!Object.hasOwn(english, key)) issues.push({ language, key, problem: "is not an English message key" });
    }

    for (const key of keys) {
      const source = english[key]!;
      const translation = catalog[key];
      let resolved = source;
      if (translation === undefined) {
        missing.push(key);
      } else {
        const problem = messageProblem(translation) ??
          (sameSet(placeholdersOf(translation), placeholdersOf(source))
            ? null
            : `uses placeholders {${[...placeholdersOf(translation)].join("}, {")}} instead of English's {${[...placeholdersOf(source)].join("}, {")}}`);
        if (problem) issues.push({ language, key, problem });
        else resolved = translation;
      }
      place(root, key, compile(resolved));
    }

    texts[language] = deepFreeze(root);
    untranslated[language] = missing;
  }

  return { texts, issues, untranslated };
}

const built = buildTexts(en, { en, "zh-TW": zhTW, ja } satisfies Record<Language, TranslationCatalog>);

export const texts = built.texts as Readonly<Record<Language, Texts>>;
export const catalogIssues: readonly CatalogIssue[] = built.issues;
export const untranslatedKeys: Readonly<Record<Language, readonly string[]>> = built.untranslated;
