/**
 * Value projection: the plain-JS view over the CST that `HCL.parse`
 * returns. Design: docs/design.md §3.1.
 *
 * Rules, in short:
 *
 * - Literal expressions (number / boolean / null) become JS primitives.
 * - Quoted strings and heredocs *with no interpolation* become plain JS
 *   strings, with HCL escape sequences unescaped. A quoted string with
 *   any interpolation is opaque — it becomes an `Expression` wrapper.
 * - Tuples of purely-collapsing items become JS arrays.
 * - Object literals with identifier / simple-string keys and
 *   collapsing values become plain JS objects.
 * - Any expression with variables, function calls, operators, splats,
 *   traversals, conditionals, or for-expressions becomes an
 *   `Expression` wrapper: `{ __hcl: "expression", kind, source, ast }`.
 *
 * Block grouping (docs/design.md §3.1): each block nests under
 * `value[type][label1][label2]...`. When two blocks share the full
 * path (including all labels), the leaf is collected into an array.
 * This is lossy for repeated *label-less* blocks — noted in the
 * design-doc risks section.
 */

import type {
  AttributeNode,
  BlockNode,
  BodyNode,
  ExprNode,
  ExprNodeKind,
  TemplateNode,
} from "./parser/nodes.js";
import { print } from "./parser/print.js";

/** Discriminator tag on every Expression wrapper. */
export const EXPRESSION_TAG = "expression" as const;

/** Semantic kind of an opaque expression wrapper. */
export type ExpressionValueKind =
  | "template"
  | "tuple"
  | "object"
  | "variable"
  | "traversal"
  | "function-call"
  | "for"
  | "conditional"
  | "binary"
  | "unary"
  | "splat"
  | "parens"
  | "error";

/**
 * Wrapper returned by `toValue` for any expression that cannot collapse
 * to a plain JS primitive / array / object. Carries both the source
 * text (for display) and the full AST (for structural manipulation).
 */
export interface Expression {
  readonly __hcl: typeof EXPRESSION_TAG;
  readonly kind: ExpressionValueKind;
  readonly source: string;
  readonly ast: ExprNode;
}

/** Recursive Value union. See docs/design.md §3.1. */
export type Value =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<Value>
  | { readonly [key: string]: Value }
  | Expression;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Convert a BodyNode into a plain-JS object Value. */
export function toValue(body: BodyNode): { [key: string]: Value } {
  const result: { [key: string]: Value } = {};
  for (const part of body.parts) {
    // Walk parts in source order so attribute / block interleaving is
    // preserved (matters only if two same-typed blocks straddle an
    // attribute — rare, but produces deterministic behavior).
    if (!isBlockOrAttribute(part)) continue;
    if (part.kind === "Attribute") {
      applyAttribute(result, part);
    } else {
      applyBlock(result, part);
    }
  }
  return result;
}

/**
 * Convert a single expression to a Value — the literal-collapsing rule
 * set from docs/design.md §3.1. Exported for tests and for tools that
 * want to walk attribute values directly.
 */
export function exprToValue(expr: ExprNode): Value {
  switch (expr.kind) {
    case "Literal":
      return expr.value;
    case "Template":
      return templateToValue(expr);
    case "Tuple": {
      const items = expr.items.map(exprToValue);
      if (items.some(isExpression)) return wrap(expr);
      return items;
    }
    case "Object": {
      const obj: { [key: string]: Value } = {};
      for (const item of expr.items) {
        const key = itemKeyToLiteralString(item.key);
        if (key === null) return wrap(expr);
        const val = exprToValue(item.value);
        if (isExpression(val)) return wrap(expr);
        obj[key] = val;
      }
      return obj;
    }
    // Every other expression kind is structural — wrap it.
    case "Variable":
    case "Traversal":
    case "Splat":
    case "Call":
    case "For":
    case "Conditional":
    case "BinaryOp":
    case "UnaryOp":
    case "Parens":
    case "ErrorExpr":
      return wrap(expr);
  }
}

/** Returns true for Expression wrapper objects. */
export function isExpression(v: unknown): v is Expression {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { __hcl?: unknown }).__hcl === EXPRESSION_TAG
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Body walking: attributes + block grouping
// ─────────────────────────────────────────────────────────────────────────────

function isBlockOrAttribute(
  part: unknown,
): part is AttributeNode | BlockNode {
  if (typeof part !== "object" || part === null) return false;
  const kind = (part as { kind?: unknown }).kind;
  return kind === "Attribute" || kind === "Block";
}

function applyAttribute(
  target: { [key: string]: Value },
  attr: AttributeNode,
): void {
  target[attr.name] = exprToValue(attr.expression);
}

/**
 * Apply block grouping: navigate `target[type][label1][label2]...` and
 * assign the block's body value at the leaf, collecting duplicates
 * into an array.
 */
function applyBlock(
  target: { [key: string]: Value },
  block: BlockNode,
): void {
  const labels = block.labels
    ? block.labels.labels.map((l) => l.value)
    : [];
  const path = [block.type, ...labels];
  const bodyValue = toValue(block.body);

  let container: { [key: string]: Value } = target;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    const existing = container[key];
    if (!isPlainObject(existing)) {
      // Either missing entirely, an array (from earlier duplicate
      // grouping), or a primitive (path collision). In the first case,
      // create a fresh object. In the latter cases we intentionally
      // overwrite — later content wins — matching hcl2-json-parser's
      // behavior on degenerate inputs.
      container[key] = {};
    }
    container = container[key] as { [key: string]: Value };
  }

  const leaf = path[path.length - 1]!;
  const existing = container[leaf];
  if (existing === undefined) {
    container[leaf] = bodyValue;
    return;
  }
  if (Array.isArray(existing)) {
    (existing as Value[]).push(bodyValue);
    return;
  }
  // Existing scalar / object → upgrade to an array with both entries.
  container[leaf] = [existing, bodyValue];
}

function isPlainObject(
  v: Value | undefined,
): v is { [key: string]: Value } {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !isExpression(v)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Expression wrapping + helpers
// ─────────────────────────────────────────────────────────────────────────────

function wrap(expr: ExprNode): Expression {
  return {
    __hcl: EXPRESSION_TAG,
    kind: exprNodeKindToValueKind(expr.kind),
    source: print(expr),
    ast: expr,
  };
}

function exprNodeKindToValueKind(k: ExprNodeKind): ExpressionValueKind {
  switch (k) {
    case "Template":
      return "template";
    case "Tuple":
      return "tuple";
    case "Object":
    case "ObjectItem":
      return "object";
    case "Variable":
      return "variable";
    case "Traversal":
      return "traversal";
    case "Splat":
      return "splat";
    case "Call":
      return "function-call";
    case "For":
      return "for";
    case "Conditional":
      return "conditional";
    case "BinaryOp":
      return "binary";
    case "UnaryOp":
      return "unary";
    case "Parens":
      return "parens";
    case "ErrorExpr":
      return "error";
    case "Literal":
      // Literal collapses to a primitive and never hits wrap(); included
      // for exhaustiveness only.
      return "variable";
  }
}

/**
 * Extract a literal string key from an object-item key expression.
 * Returns null when the key is computed (paren'd expression) or any
 * other non-collapsing form — which forces the parent object to become
 * an Expression wrapper.
 */
function itemKeyToLiteralString(key: ExprNode): string | null {
  if (key.kind === "Variable") {
    // Identifier shortcut: `{foo = 1}` has key "foo" as a literal.
    return key.name;
  }
  if (key.kind === "Template") {
    // Only no-interpolation templates can collapse to a literal key.
    if (isPureLiteralTemplate(key)) {
      return cookTemplateLiteral(key);
    }
  }
  if (key.kind === "Literal" && key.valueType !== "null") {
    // Numeric or boolean keys become their stringified form, matching
    // how hcl2-json-parser coerces non-string object keys.
    return String(key.value);
  }
  return null;
}

function isPureLiteralTemplate(t: TemplateNode): boolean {
  return t.templateParts.every((p) => p.kind === "StringPart");
}

function templateToValue(t: TemplateNode): Value {
  if (!isPureLiteralTemplate(t)) return wrap(t);
  return cookTemplateLiteral(t);
}

/** Concatenate a pure-literal template's string parts and unescape. */
function cookTemplateLiteral(t: TemplateNode): string {
  let raw = "";
  for (const p of t.templateParts) {
    if (p.kind === "StringPart") raw += p.text;
  }
  return unescapeTemplateLiteral(raw, t.isHeredoc);
}

// ─────────────────────────────────────────────────────────────────────────────
// HCL2 string-literal escape processing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply HCL escape sequences to a raw literal string captured between a
 * template's open and close tokens. Quoted strings honor both the
 * backslash escapes (\\n, \\t, \\\", \\\\, \\r, \\uNNNN, \\UNNNNNNNN)
 * and the `$${` / `%%{` template-marker escapes. Heredocs honor only
 * the template-marker escapes — backslash has no special meaning in
 * heredoc bodies.
 */
export function unescapeTemplateLiteral(raw: string, isHeredoc: boolean): string {
  let out = "";
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const c = raw.charCodeAt(i);
    // $${ → ${
    if (c === 0x24 && raw.charCodeAt(i + 1) === 0x24 && raw.charCodeAt(i + 2) === 0x7b) {
      out += "${";
      i += 3;
      continue;
    }
    // %%{ → %{
    if (c === 0x25 && raw.charCodeAt(i + 1) === 0x25 && raw.charCodeAt(i + 2) === 0x7b) {
      out += "%{";
      i += 3;
      continue;
    }
    if (!isHeredoc && c === 0x5c /* \ */) {
      const n2 = raw.charCodeAt(i + 1);
      switch (n2) {
        case 0x6e /* n */:
          out += "\n";
          i += 2;
          continue;
        case 0x72 /* r */:
          out += "\r";
          i += 2;
          continue;
        case 0x74 /* t */:
          out += "\t";
          i += 2;
          continue;
        case 0x22 /* " */:
          out += '"';
          i += 2;
          continue;
        case 0x5c /* \ */:
          out += "\\";
          i += 2;
          continue;
        case 0x75 /* u */: {
          const hex = raw.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCodePoint(parseInt(hex, 16));
            i += 6;
            continue;
          }
          break;
        }
        case 0x55 /* U */: {
          const hex = raw.slice(i + 2, i + 10);
          if (/^[0-9a-fA-F]{8}$/.test(hex)) {
            const cp = parseInt(hex, 16);
            if (cp <= 0x10ffff) {
              out += String.fromCodePoint(cp);
              i += 10;
              continue;
            }
          }
          break;
        }
      }
      // Unknown backslash escape — pass through as-is (matches the
      // lenient behavior of hcl2-json-parser for unrecognized escapes).
      out += raw[i]!;
      i += 1;
      continue;
    }
    out += raw[i]!;
    i += 1;
  }
  return out;
}
