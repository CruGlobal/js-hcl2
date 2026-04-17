/**
 * `Document` — the trivia-aware, mutable view over a parsed HCL source.
 *
 * Unlike `HCL.parse` which produces a lossy plain-JS `Value`, `Document`
 * keeps the full CST. `Document.toString()` is byte-identical to the
 * original source for any well-formed input, and `set` / `delete`
 * mutate the tree in place while preserving surrounding trivia
 * (comments, blank lines, indentation) per the guarantees in
 * docs/design.md §7.2.
 *
 * M7 scope (per the milestone scope question):
 *   - set / delete for attributes at any body level
 *   - delete for whole blocks identified by type + labels
 *   - insertion of new attributes at the end of the enclosing body
 *   - numeric path segments index into duplicate-block groups
 *
 * Out of scope for M7: editing block headers (type, labels), replacing
 * a whole block with a new subtree.
 */

import { HCLParseError } from "../errors.js";
import { SourceFile } from "../source.js";
import { TokenKind, type Token } from "../lexer/token.js";
import {
  parse as parseBody,
  type ParserOptions,
} from "../parser/parser.js";
import type {
  AttributeNode,
  BlockNode,
  BodyNode,
  ExprNode,
  Node,
} from "../parser/nodes.js";
import { print } from "../parser/print.js";
import { stringifyExpression } from "../printer/canonical.js";
import { toValue, type Value } from "../value.js";

export interface DocumentOptions {
  /** Filename used in error messages. Default: "<input>". */
  filename?: string;
  /**
   * Throw on first error (default) or collect all errors and throw an
   * aggregate HCLParseError with `errors[]`.
   */
  bail?: boolean;
}

/** One segment of a path — identifier, string, or numeric index. */
export type PathSegment = string | number;

export class Document {
  /**
   * The SourceFile wrapping the original input (unchanged by edits —
   * the live CST stays in `body`).
   */
  readonly source: SourceFile;
  /**
   * Mutable CST root. Edits to the body (via the editing API or by
   * direct mutation) show up in subsequent `toString()` / `toValue()`
   * calls.
   */
  readonly body: BodyNode;

  constructor(sourceText: string, options: DocumentOptions = {}) {
    const src = new SourceFile(sourceText, options.filename);
    const result = parseBody(src, {
      bail: options.bail ?? true,
    } satisfies ParserOptions);
    if (result.errors.length > 0) {
      const first = result.errors[0]!;
      const message =
        result.errors.length === 1
          ? first.message
          : `${result.errors.length} parse errors; first: ${first.message}`;
      throw new HCLParseError(src, first.range, message, result.errors);
    }
    this.source = src;
    this.body = result.body;
  }

  /**
   * Re-emit the current CST. For an unedited Document, this is
   * byte-identical to the original source by construction.
   */
  toString(): string {
    return print(this.body);
  }

  /** Convert the CST to the same `Value` shape that `HCL.parse` returns. */
  toValue(): Value {
    return toValue(this.body);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Navigation
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Resolve a path to its CST node. Returns undefined if the path does
   * not exist. For duplicate-block groups with no numeric index given,
   * returns the first matching block (matching `HCL.parse`'s grouping
   * semantics when accessing by key).
   */
  get(path: string | PathSegment[]): Node | undefined {
    const segs = parsePath(path);
    const resolved = resolve(this.body, segs);
    return resolved?.node;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Edits
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Replace the value of an existing attribute, or insert a new
   * attribute at the end of the enclosing body. The attribute's
   * surrounding trivia (leading comments, same-line trailing comments)
   * is preserved on replacement.
   */
  set(path: string | PathSegment[], value: Value): void {
    const segs = parsePath(path);
    if (segs.length === 0) {
      throw new Error("set() requires a non-empty path");
    }
    const resolved = resolve(this.body, segs);
    if (resolved && resolved.node.kind === "Attribute") {
      replaceAttributeValue(resolved.node, value);
      return;
    }
    // Insert a new attribute. Parent path is everything but the last
    // segment; the last segment is the new attribute name.
    const parentSegs = segs.slice(0, -1);
    const newName = segs[segs.length - 1];
    if (typeof newName !== "string") {
      throw new Error("new attribute name must be a string");
    }
    const parent = parentSegs.length === 0
      ? this.body
      : parentBodyFor(this.body, parentSegs);
    if (!parent) {
      throw new Error(`set() could not locate parent body for path ${JSON.stringify(segs)}`);
    }
    insertAttribute(parent, newName, value);
  }

  /**
   * Remove an attribute or block at `path`. Returns true when something
   * was removed, false when the path did not resolve.
   */
  delete(path: string | PathSegment[]): boolean {
    const segs = parsePath(path);
    if (segs.length === 0) return false;
    const resolved = resolve(this.body, segs);
    if (!resolved) return false;
    if (resolved.node.kind !== "Attribute" && resolved.node.kind !== "Block") {
      return false;
    }
    return removeBodyChild(resolved.parentBody, resolved.indexInParts);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Path parsing
// ─────────────────────────────────────────────────────────────────────────────

function parsePath(path: string | PathSegment[]): PathSegment[] {
  if (Array.isArray(path)) {
    return path.map((s) => coerceSegment(s));
  }
  if (path.length === 0) return [];
  return path.split(".").map((s) => coerceSegment(s));
}

function coerceSegment(s: PathSegment): PathSegment {
  if (typeof s === "number") return s;
  return /^\d+$/.test(s) ? Number(s) : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Navigation internals
// ─────────────────────────────────────────────────────────────────────────────

interface Resolved {
  readonly node: Node;
  readonly parentBody: BodyNode;
  readonly indexInParts: number;
}

/**
 * Walk the CST to find the node for `segments`. Returns the node along
 * with its parent body and index in that body's `parts` array (needed
 * for delete and for locating insertion points).
 */
function resolve(
  body: BodyNode,
  segments: PathSegment[],
): Resolved | undefined {
  if (segments.length === 0) return undefined;
  const [first, ...rest] = segments;

  // Attribute match. Only valid when the path terminates here.
  if (typeof first === "string") {
    const attrIdx = body.parts.findIndex(
      (p) => isAttribute(p) && p.name === first,
    );
    if (attrIdx >= 0) {
      const node = body.parts[attrIdx]!;
      if (rest.length === 0 && isAttribute(node)) {
        return { node, parentBody: body, indexInParts: attrIdx };
      }
      // Attribute match but path continues — attributes hold expressions
      // which this version does not descend into.
      return undefined;
    }
  }

  // Block match: peel labels, then optionally an index, then descend.
  if (typeof first !== "string") return undefined;
  return resolveBlock(body, first, rest);
}

function resolveBlock(
  body: BodyNode,
  type: string,
  rest: PathSegment[],
): Resolved | undefined {
  // Find all candidate blocks of this type.
  const candidates: { block: BlockNode; idx: number }[] = [];
  body.parts.forEach((p, idx) => {
    if (isBlock(p) && p.type === type) candidates.push({ block: p, idx });
  });
  if (candidates.length === 0) return undefined;

  // Peel label segments as long as they match. A candidate is kept in
  // the running if its labels agree with the peeled segments so far.
  let labelDepth = 0;
  let matching = candidates;
  while (labelDepth < rest.length) {
    const seg = rest[labelDepth];
    if (typeof seg !== "string") break;
    const next = matching.filter(({ block }) => {
      const labels = block.labels?.labels ?? [];
      return labels[labelDepth]?.value === seg;
    });
    if (next.length === 0) break;
    matching = next;
    labelDepth++;
  }

  // Narrow to blocks whose label count exactly matches the peel depth —
  // otherwise the path segment is either an index into a duplicate
  // group or a body-level key.
  let exact = matching.filter(
    ({ block }) => (block.labels?.labels.length ?? 0) === labelDepth,
  );
  if (exact.length === 0) {
    // No exact match; still allow longer-label blocks to match a path
    // that stops at the type (test: {"resource"} against a resource
    // with 2 labels). Caller sees the first candidate.
    exact = matching;
  }

  let remaining = rest.slice(labelDepth);

  // Numeric index into the duplicate-block group.
  if (remaining.length > 0 && typeof remaining[0] === "number") {
    const i = remaining[0];
    if (i < 0 || i >= exact.length) return undefined;
    const chosen = exact[i]!;
    remaining = remaining.slice(1);
    if (remaining.length === 0) {
      return {
        node: chosen.block,
        parentBody: body,
        indexInParts: chosen.idx,
      };
    }
    return resolve(chosen.block.body, remaining);
  }

  if (remaining.length === 0) {
    const chosen = exact[0]!;
    return {
      node: chosen.block,
      parentBody: body,
      indexInParts: chosen.idx,
    };
  }

  // Descend: with multiple candidates and no index, pick the first.
  const chosen = exact[0]!;
  return resolve(chosen.block.body, remaining);
}

/**
 * Find the BodyNode that WOULD contain an attribute whose key is the
 * last segment of `parentSegs`. Used by set() when the path does not
 * currently resolve. Creates no new structure — returns undefined if
 * the parent body itself can't be located.
 */
function parentBodyFor(
  rootBody: BodyNode,
  parentSegs: PathSegment[],
): BodyNode | undefined {
  if (parentSegs.length === 0) return rootBody;
  const resolved = resolve(rootBody, parentSegs);
  if (!resolved) return undefined;
  if (resolved.node.kind === "Block") return resolved.node.body;
  return undefined;
}

function isAttribute(n: unknown): n is AttributeNode {
  return (
    typeof n === "object" &&
    n !== null &&
    (n as { kind?: unknown }).kind === "Attribute"
  );
}

function isBlock(n: unknown): n is BlockNode {
  return (
    typeof n === "object" &&
    n !== null &&
    (n as { kind?: unknown }).kind === "Block"
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation: attribute value replacement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replace `attr.expression` with a newly-built ExprNode carrying the
 * given Value. The IDENT + ASSIGN tokens and trivia around them stay
 * untouched; the replacement preserves the old expression's first-
 * token leading trivia (the space after `=`) and last-token trailing
 * trivia (typically empty, occasionally a same-line comment).
 */
function replaceAttributeValue(attr: AttributeNode, value: Value): void {
  const oldExpr = attr.expression;
  const oldFirst = firstToken(oldExpr);
  const oldLast = lastToken(oldExpr);

  const newExprText = stringifyExpression(value);
  const newExpr = parseExpressionStandalone(newExprText);

  // Preserve adjacent trivia.
  const newFirst = firstToken(newExpr);
  const newLast = lastToken(newExpr);
  if (oldFirst && newFirst) {
    mutateToken(newFirst, { leadingTrivia: oldFirst.leadingTrivia });
  }
  if (oldLast && newLast) {
    mutateToken(newLast, { trailingTrivia: oldLast.trailingTrivia });
  }

  // Splice the new expression in place of the old.
  const parts = attr.parts as unknown as (Token | ExprNode)[];
  const exprIdx = parts.indexOf(oldExpr);
  if (exprIdx < 0) {
    throw new Error("internal: attribute's expression not found in parts");
  }
  parts[exprIdx] = newExpr;
  (attr as { expression: ExprNode }).expression = newExpr;
  // Range end moves with the new expression.
  (attr as { range: AttributeNode["range"] }).range = {
    start: attr.range.start,
    end: newExpr.range.end,
  };
}

/**
 * Parse a fragment of HCL as a standalone expression. Used by
 * replaceAttributeValue to get a fully-structured ExprNode from
 * canonical-printer output.
 */
function parseExpressionStandalone(text: string): ExprNode {
  // Scaffold as an attribute so parseBody handles it reliably; extract
  // the expression afterwards. `a` is a minimal valid HCL identifier.
  const scaffolded = `a = ${text}\n`;
  const src = new SourceFile(scaffolded);
  const result = parseBody(src, { bail: true });
  const attr = result.body.attributes[0];
  if (!attr) throw new Error("internal: canonical printer produced unparseable expression");
  return attr.expression;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation: new attribute insertion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append a new attribute to the end of `body`. Indentation is copied
 * from the body's existing attributes; if none exist, the default is
 * two spaces of parent indent. The new entry is preceded by a NEWLINE
 * so it does not merge with the previous statement.
 */
function insertAttribute(
  body: BodyNode,
  name: string,
  value: Value,
): void {
  const indentTrivia = detectBodyIndent(body);
  // Build the attribute source directly: `name = <expr>`. Using
  // stringifyExpression keeps object-typed values as object literals
  // rather than letting the body-level block-vs-attribute policy kick
  // in and emit them as blocks.
  const keyText = /^[A-Za-z\u00A0-\uFFFF][A-Za-z0-9\u00A0-\uFFFF_-]*$/.test(name)
    ? name
    : JSON.stringify(name);
  const exprText = stringifyExpression(value);
  const attrSource = `${keyText} = ${exprText}`;
  const scaffolded = `${attrSource}\n`;
  const parsed = parseBody(new SourceFile(scaffolded), { bail: true });
  const newAttr = parsed.body.attributes[0];
  if (!newAttr) {
    throw new Error("internal: could not parse newly-formatted attribute");
  }

  // Stamp the attribute's first-token leading trivia with the target
  // indent (stripping whatever the re-parse inherited).
  const first = firstToken(newAttr);
  if (first) mutateToken(first, { leadingTrivia: indentTrivia });

  const parts = body.parts as unknown as (AttributeNode | BlockNode | Token)[];
  // If the body does not already end with a NEWLINE (rare — only for
  // bodies that ended with a statement token without trailing newline),
  // insert one first. Otherwise append directly, followed by a fresh
  // NEWLINE so subsequent inserts behave identically.
  const { insertAt, needsLeadingNewline } = findAppendInsertion(parts);
  const additions: (AttributeNode | BlockNode | Token)[] = [];
  if (needsLeadingNewline) additions.push(makeNewlineToken());
  additions.push(newAttr);
  additions.push(makeNewlineToken());
  parts.splice(insertAt, 0, ...additions);
}

/**
 * Work out where to insert new statements in a body: just before the
 * EOF token (if present) or at the very end. Also indicates whether a
 * leading NEWLINE is needed (true when the last content before the
 * insertion point is not already a NEWLINE).
 */
function findAppendInsertion(
  parts: ReadonlyArray<AttributeNode | BlockNode | Token>,
): { insertAt: number; needsLeadingNewline: boolean } {
  // EOF is always the last token in the root body; block bodies don't
  // carry one.
  let insertAt = parts.length;
  const last = parts[parts.length - 1];
  if (last && !isNode(last) && last.kind === TokenKind.EOF) {
    insertAt = parts.length - 1;
  }
  const prev = parts[insertAt - 1];
  const needsLeadingNewline =
    prev !== undefined && (isNode(prev) || prev.kind !== TokenKind.NEWLINE);
  return { insertAt, needsLeadingNewline };
}

function isNode(x: unknown): x is AttributeNode | BlockNode {
  return typeof x === "object" && x !== null && !("lexeme" in x);
}

function detectBodyIndent(body: BodyNode): string {
  for (const part of body.parts) {
    if (isAttribute(part) || isBlock(part)) {
      const first = firstToken(part);
      if (first) {
        // Pull the indentation from the first-token leading trivia.
        const match = /[ \t]*$/.exec(first.leadingTrivia);
        return match ? match[0] : "";
      }
    }
  }
  return "";
}

function makeNewlineToken(): Token {
  // A synthetic NEWLINE used for inserted separators. It carries no
  // trivia of its own — any leading / trailing context belongs to
  // adjacent real tokens.
  return {
    kind: TokenKind.NEWLINE,
    lexeme: "\n",
    leadingTrivia: "",
    trailingTrivia: "",
    range: {
      start: { line: 0, column: 0, offset: 0 },
      end: { line: 0, column: 0, offset: 1 },
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutation: deletion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove `body.parts[index]` (an attribute or block) and the NEWLINE
 * immediately following it, if one is present, so the deletion does
 * not leave a blank line behind.
 */
function removeBodyChild(body: BodyNode, index: number): boolean {
  const parts = body.parts as unknown as (AttributeNode | BlockNode | Token)[];
  if (index < 0 || index >= parts.length) return false;
  let deleteCount = 1;
  const next = parts[index + 1];
  if (next && !isNode(next) && next.kind === TokenKind.NEWLINE) {
    deleteCount = 2;
  }
  parts.splice(index, deleteCount);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Token helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Find the very first Token in a tree (descending into nested nodes). */
function firstToken(n: Node | ExprNode | Token): Token | undefined {
  if (isTokenLike(n)) return n;
  for (const part of (n as { parts: ReadonlyArray<unknown> }).parts) {
    const tok = firstToken(part as Node | Token);
    if (tok) return tok;
  }
  return undefined;
}

/** Find the last Token in a tree. */
function lastToken(n: Node | ExprNode | Token): Token | undefined {
  if (isTokenLike(n)) return n;
  const parts = (n as { parts: ReadonlyArray<unknown> }).parts;
  for (let i = parts.length - 1; i >= 0; i--) {
    const tok = lastToken(parts[i] as Node | Token);
    if (tok) return tok;
  }
  return undefined;
}

function isTokenLike(n: unknown): n is Token {
  return typeof n === "object" && n !== null && "lexeme" in n;
}

/** Write to a token's trivia. Tokens are readonly in the public API but
 *  mutable at runtime — this helper makes the intentional mutation
 *  explicit at call sites. */
function mutateToken(
  tok: Token,
  patch: Partial<Pick<Token, "leadingTrivia" | "trailingTrivia">>,
): void {
  const m = tok as { leadingTrivia: string; trailingTrivia: string };
  if (patch.leadingTrivia !== undefined) m.leadingTrivia = patch.leadingTrivia;
  if (patch.trailingTrivia !== undefined) m.trailingTrivia = patch.trailingTrivia;
}
