/**
 * Canonical Value → HCL text printer.
 *
 * Implements the rules in docs/design.md §8. Opinionated output; pairs
 * with the M5 Value projection so that, for any well-formed JS value v,
 * `parse(stringify(v))` is structurally equal to v. Not byte-for-byte
 * round-trip — that's the Document API (M7). This printer normalizes
 * whitespace, ordering, and choice of block vs attribute.
 *
 * Block vs attribute policy (body level):
 *   - Expression, primitive, array of non-objects, or empty array  → attribute
 *   - Plain object                                                 → block
 *   - Non-empty array of plain objects                             → repeated blocks
 *
 * Label peeling for blocks: if a block body is itself a "label layer"
 * (every key is a valid HCL identifier and every value is a plain
 * object or an array of plain objects), each key becomes an additional
 * block label and the printer recurses into its value. This reproduces
 * Terraform's `resource "type" "name" {}` shape from the corresponding
 * nested Value.
 */

import { isIdContinue, isIdStart } from "../unicode.js";
import type { Expression, Value } from "../value.js";
import { isExpression } from "../value.js";

export interface StringifyOptions {
  /** Spaces per indent level. Default: 2. Tabs are never emitted. */
  indent?: number;
  /** Emit a trailing newline at EOF. Default: true. */
  trailingNewline?: boolean;
  /** Sort object/block-body keys alphabetically. Default: false. */
  sortKeys?: boolean;
  /**
   * JSON-style replacer. Called for every (key, value) pair as the
   * printer walks the tree. Return `undefined` to omit the pair.
   */
  replacer?: (key: string, value: unknown) => unknown;
}

export interface ResolvedStringifyOptions {
  readonly indent: number;
  readonly trailingNewline: boolean;
  readonly sortKeys: boolean;
  readonly replacer: ((key: string, value: unknown) => unknown) | undefined;
}

const DEFAULTS: ResolvedStringifyOptions = {
  indent: 2,
  trailingNewline: true,
  sortKeys: false,
  replacer: undefined,
};

/** Canonical stringify. See StringifyOptions for options. */
export function stringify(value: Value, options: StringifyOptions = {}): string {
  const opts: ResolvedStringifyOptions = {
    indent: options.indent ?? DEFAULTS.indent,
    trailingNewline: options.trailingNewline ?? DEFAULTS.trailingNewline,
    sortKeys: options.sortKeys ?? DEFAULTS.sortKeys,
    replacer: options.replacer,
  };

  const root = applyReplacer("", value, opts.replacer);
  if (!isPlainObject(root)) {
    throw new TypeError(
      `HCL.stringify expects a plain object at the root (got ${describe(root)})`,
    );
  }

  const out: string[] = [];
  printBody(root, 0, opts, out);
  let text = out.join("");

  // Guarantee (or suppress) a trailing newline, depending on option.
  if (opts.trailingNewline) {
    if (!text.endsWith("\n")) text += "\n";
  } else if (text.endsWith("\n")) {
    text = text.slice(0, -1);
  }
  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Body and statement emission
// ─────────────────────────────────────────────────────────────────────────────

function printBody(
  obj: Record<string, Value>,
  depth: number,
  opts: ResolvedStringifyOptions,
  out: string[],
): void {
  const keys = opts.sortKeys
    ? [...Object.keys(obj)].sort()
    : Object.keys(obj);
  for (const key of keys) {
    const raw = obj[key];
    const value = applyReplacer(key, raw, opts.replacer);
    if (value === undefined) continue;
    printBodyEntry(key, value, depth, opts, out);
  }
}

function printBodyEntry(
  key: string,
  value: Value,
  depth: number,
  opts: ResolvedStringifyOptions,
  out: string[],
): void {
  if (isExpression(value)) {
    emitAttribute(key, value, depth, opts, out);
    return;
  }
  if (Array.isArray(value) && value.length > 0 && value.every(isPlainObject)) {
    for (const item of value) {
      emitAsBlocks(key, [], item, depth, opts, out);
    }
    return;
  }
  if (isPlainObject(value)) {
    emitAsBlocks(key, [], value, depth, opts, out);
    return;
  }
  emitAttribute(key, value, depth, opts, out);
}

/** Drives block emission, including label peeling. */
function emitAsBlocks(
  type: string,
  labels: readonly string[],
  body: Record<string, Value>,
  depth: number,
  opts: ResolvedStringifyOptions,
  out: string[],
): void {
  if (isLabelLayer(body)) {
    const keys = opts.sortKeys
      ? [...Object.keys(body)].sort()
      : Object.keys(body);
    for (const label of keys) {
      const inner = body[label]!;
      if (
        Array.isArray(inner) &&
        inner.length > 0 &&
        inner.every(isPlainObject)
      ) {
        for (const item of inner) {
          emitAsBlocks(type, [...labels, label], item, depth, opts, out);
        }
      } else if (isPlainObject(inner)) {
        emitAsBlocks(type, [...labels, label], inner, depth, opts, out);
      } else {
        // Shouldn't happen because isLabelLayer enforces plain-object
        // (or array-of-plain-object) children, but be defensive: fall
        // back to emitting this entry as a nested attribute within a
        // body that also carries the peeled block's body.
        emitBlockShell(type, labels, body, depth, opts, out);
        return;
      }
    }
    return;
  }
  emitBlockShell(type, labels, body, depth, opts, out);
}

function emitBlockShell(
  type: string,
  labels: readonly string[],
  body: Record<string, Value>,
  depth: number,
  opts: ResolvedStringifyOptions,
  out: string[],
): void {
  const header = [formatIdentOrQuoted(type), ...labels.map(quotedString)].join(" ");
  const prefix = indent(depth, opts);
  if (Object.keys(body).length === 0) {
    out.push(`${prefix}${header} {}\n`);
    return;
  }
  out.push(`${prefix}${header} {\n`);
  printBody(body, depth + 1, opts, out);
  out.push(`${prefix}}\n`);
}

function emitAttribute(
  key: string,
  value: Value,
  depth: number,
  opts: ResolvedStringifyOptions,
  out: string[],
): void {
  const prefix = indent(depth, opts);
  const keyText = formatIdentOrQuoted(key);
  const valueText = printValueExpression(value, depth, opts);
  out.push(`${prefix}${keyText} = ${valueText}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Expression position: value printing
// ─────────────────────────────────────────────────────────────────────────────

function printValueExpression(
  value: Value,
  depth: number,
  opts: ResolvedStringifyOptions,
): string {
  if (isExpression(value)) return printExpressionWrapper(value, depth, opts);
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return printNumber(value);
  if (typeof value === "string") return printString(value, depth, opts);
  if (Array.isArray(value)) return printTuple(value, depth, opts);
  if (isPlainObject(value)) return printObjectLiteral(value, depth, opts);
  return "null";
}

function printExpressionWrapper(
  expr: Expression,
  _depth: number,
  _opts: ResolvedStringifyOptions,
): string {
  // Emit the original source verbatim. Re-indenting a multi-line
  // Expression would mutate heredoc body content (heredoc bodies are
  // whitespace-sensitive); preserving `.source` as-is is the only safe
  // option, and makes the round-trip property trivially hold for any
  // expression wrapper the parser produced.
  return expr.source;
}

function printNumber(n: number): string {
  // Non-finite numbers have no HCL representation; encode as null.
  if (!Number.isFinite(n)) return "null";
  return String(n);
}

function printTuple(
  items: ReadonlyArray<Value>,
  depth: number,
  opts: ResolvedStringifyOptions,
): string {
  if (items.length === 0) return "[]";
  const flatParts = items.map((v) => printValueExpression(v, depth, opts));
  const inline = `[${flatParts.join(", ")}]`;
  if (fitsInline(indent(depth, opts).length + inline.length) && !containsNewline(inline)) {
    return inline;
  }
  const innerIndent = indent(depth + 1, opts);
  const outerIndent = indent(depth, opts);
  const body = flatParts.map((p) => `${innerIndent}${p},`).join("\n");
  return `[\n${body}\n${outerIndent}]`;
}

function printObjectLiteral(
  obj: Record<string, Value>,
  depth: number,
  opts: ResolvedStringifyOptions,
): string {
  const keys = opts.sortKeys ? [...Object.keys(obj)].sort() : Object.keys(obj);
  if (keys.length === 0) return "{}";
  const entries: string[] = [];
  for (const k of keys) {
    const raw = obj[k]!;
    const value = applyReplacer(k, raw, opts.replacer);
    if (value === undefined) continue;
    const keyText = formatIdentOrQuoted(k);
    const valText = printValueExpression(value, depth, opts);
    entries.push(`${keyText} = ${valText}`);
  }
  if (entries.length === 0) return "{}";
  const inline = `{ ${entries.join(", ")} }`;
  if (fitsInline(indent(depth, opts).length + inline.length) && !containsNewline(inline)) {
    return inline;
  }
  const innerIndent = indent(depth + 1, opts);
  const outerIndent = indent(depth, opts);
  const body = entries.map((e) => `${innerIndent}${e}`).join("\n");
  return `{\n${body}\n${outerIndent}}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Strings (quoted + heredoc) with escape handling
// ─────────────────────────────────────────────────────────────────────────────

const HEREDOC_NEWLINE_THRESHOLD = 2;
const HEREDOC_WIDTH_THRESHOLD = 80;

function printString(
  value: string,
  depth: number,
  opts: ResolvedStringifyOptions,
): string {
  // Heredocs always end with a newline (the one before the closing
  // delimiter is part of the body). We can only lossly emit a value as
  // a heredoc when it already ends with \n — otherwise fall back to a
  // quoted string even if it would otherwise cross the thresholds.
  const newlineCount = countOccurrences(value, "\n");
  const shouldConsiderHeredoc =
    newlineCount > HEREDOC_NEWLINE_THRESHOLD ||
    quotedString(value).length > HEREDOC_WIDTH_THRESHOLD;
  if (shouldConsiderHeredoc && value.endsWith("\n")) {
    return printHeredoc(value, depth, opts);
  }
  return quotedString(value);
}

function quotedString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // Escape template markers so the printed text isn't re-interpreted
    // on a subsequent parse.
    if (c === 0x24 /* $ */ && s.charCodeAt(i + 1) === 0x7b /* { */) {
      out += "$${";
      i++;
      continue;
    }
    if (c === 0x25 /* % */ && s.charCodeAt(i + 1) === 0x7b /* { */) {
      out += "%%{";
      i++;
      continue;
    }
    switch (c) {
      case 0x22:
        out += '\\"';
        continue;
      case 0x5c:
        out += "\\\\";
        continue;
      case 0x0a:
        out += "\\n";
        continue;
      case 0x0d:
        out += "\\r";
        continue;
      case 0x09:
        out += "\\t";
        continue;
      default:
        if (c < 0x20) {
          out += "\\u" + c.toString(16).padStart(4, "0");
          continue;
        }
        out += s[i]!;
    }
  }
  out += '"';
  return out;
}

function printHeredoc(
  value: string,
  depth: number,
  opts: ResolvedStringifyOptions,
): string {
  // Caller guarantees `value.endsWith("\n")`; that final newline is the
  // one that separates the last content line from the closing delimiter
  // line.
  // Escape only template markers; heredoc bodies don't use backslash
  // escapes.
  const escaped = value.replace(/\$\{/g, "$${").replace(/%\{/g, "%%{");
  const delimiter = chooseHeredocDelimiter(escaped);
  return `<<${delimiter}\n${escaped}${indent(depth, opts)}${delimiter}`;
}

function chooseHeredocDelimiter(body: string): string {
  let name = "EOT";
  let n = 0;
  // The delimiter must not appear as a whole-line token inside the body.
  const hasCollision = (d: string): boolean => {
    const lines = body.split(/\r?\n/);
    return lines.some((l) => l.trim() === d);
  };
  while (hasCollision(name)) {
    n++;
    name = `EOT${n}`;
  }
  return name;
}

// ─────────────────────────────────────────────────────────────────────────────
// Identifier + key formatting
// ─────────────────────────────────────────────────────────────────────────────

export function isValidIdentifier(s: string): boolean {
  if (s.length === 0) return false;
  const first = s.codePointAt(0)!;
  if (!isIdStart(first)) return false;
  let i = first > 0xffff ? 2 : 1;
  while (i < s.length) {
    const cp = s.codePointAt(i)!;
    if (!isIdContinue(cp)) return false;
    i += cp > 0xffff ? 2 : 1;
  }
  return true;
}

function formatIdentOrQuoted(key: string): string {
  return isValidIdentifier(key) ? key : quotedString(key);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function applyReplacer(
  key: string,
  value: unknown,
  replacer: ResolvedStringifyOptions["replacer"],
): Value {
  if (!replacer) return value as Value;
  return replacer(key, value) as Value;
}

function isPlainObject(v: unknown): v is Record<string, Value> {
  if (typeof v !== "object" || v === null) return false;
  if (Array.isArray(v)) return false;
  if (isExpression(v)) return false;
  // Exclude non-plain objects (Date, Map, etc.). A "plain" object has a
  // null prototype or Object.prototype as its prototype.
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === null || proto === Object.prototype;
}

function isLabelLayer(obj: Record<string, Value>): boolean {
  const entries = Object.entries(obj);
  if (entries.length === 0) return false;
  for (const [k, v] of entries) {
    if (!isValidIdentifier(k)) return false;
    if (isPlainObject(v)) continue;
    if (Array.isArray(v) && v.length > 0 && v.every(isPlainObject)) continue;
    return false;
  }
  return true;
}

function indent(depth: number, opts: ResolvedStringifyOptions): string {
  return " ".repeat(depth * opts.indent);
}

function countOccurrences(s: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = s.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

const INLINE_WIDTH_LIMIT = 80;

function fitsInline(width: number): boolean {
  return width <= INLINE_WIDTH_LIMIT;
}

function containsNewline(s: string): boolean {
  return s.indexOf("\n") !== -1;
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
