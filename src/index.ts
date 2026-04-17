/**
 * @cruglobal/js-hcl2 — HashiCorp Configuration Language v2 parser and encoder.
 *
 * As of M5 the public `HCL.parse(source, options?)` entry point is live.
 * `HCL.stringify` (M6) and `HCL.parseDocument` (M7) are still stubs.
 */

import { HCLParseError } from "./errors.js";
import { SourceFile } from "./source.js";
import { parse as parseBodyInternal } from "./parser/parser.js";
import { toValue, type Value } from "./value.js";

// ─────────────────────────────────────────────────────────────────────────────
// Library re-exports (types + lower-level helpers)
// ─────────────────────────────────────────────────────────────────────────────

export { HCLParseError, formatSnippet } from "./errors.js";
export type { Position, Range } from "./source.js";
export { SourceFile } from "./source.js";
export { lex, Lexer } from "./lexer/lexer.js";
export { TokenKind } from "./lexer/token.js";
export type { Token } from "./lexer/token.js";
export {
  parse as parseBody,
  parseExpr,
  Parser,
} from "./parser/parser.js";
export { print } from "./parser/print.js";
export type { ParserOptions, ParseResult } from "./parser/parser.js";
export type {
  Node,
  NodeKind,
  BodyNode,
  AttributeNode,
  BlockNode,
  BlockLabelsNode,
  LabelInfo,
  // Expression AST
  ExprNode,
  ExprNodeKind,
  LiteralNode,
  VariableNode,
  TupleNode,
  ObjectNode,
  ObjectItemNode,
  TraversalNode,
  TraversalStep,
  GetAttrStep,
  IndexStep,
  SplatNode,
  FunctionCallNode,
  ForNode,
  ConditionalNode,
  BinaryOpNode,
  UnaryOpNode,
  ParensNode,
  ErrorExprNode,
  TemplateNode,
  TemplatePart,
  TemplatePartKind,
  TemplateStringPart,
  TemplateInterpolationPart,
  TemplateIfDirectivePart,
  TemplateForDirectivePart,
  BinaryOp,
  UnaryOp,
} from "./parser/nodes.js";
export { isToken } from "./parser/nodes.js";

// Value projection
export { toValue, exprToValue, isExpression, unescapeTemplateLiteral } from "./value.js";
export type { Value, Expression, ExpressionValueKind } from "./value.js";
export { EXPRESSION_TAG } from "./value.js";

// ─────────────────────────────────────────────────────────────────────────────
// Public top-level API
// ─────────────────────────────────────────────────────────────────────────────

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented yet (pre-alpha)`);
    this.name = "NotImplementedError";
  }
}

/** Options accepted by the top-level `HCL.parse`. */
export interface ParseOptions {
  /** Filename used in error messages. Default: "<input>". */
  filename?: string;
  /**
   * When true (the default), throw on the first parse error. When false,
   * collect all errors and throw a single aggregate HCLParseError whose
   * `errors[]` array contains every individual failure.
   */
  bail?: boolean;
}

export interface StringifyOptions {
  indent?: number;
  quotes?: "double";
  trailingNewline?: boolean;
  sortKeys?: boolean;
  replacer?: (key: string, value: unknown) => unknown;
}

export interface Document {
  toString(): string;
  toValue(): Value;
}

/**
 * Parse HCL source text into a plain-JS `Value`. See docs/design.md §3.1
 * for the value shape and docs/design.md §3.4 for error semantics.
 */
export function parse(source: string, options: ParseOptions = {}): Value {
  const sourceFile = new SourceFile(source, options.filename);
  const result = parseBodyInternal(sourceFile, { bail: options.bail ?? true });
  if (result.errors.length > 0) {
    // Only reachable when bail=false and at least one error was
    // collected. Wrap the individual errors into a single aggregate.
    const first = result.errors[0]!;
    const message =
      result.errors.length === 1
        ? first.message
        : `${result.errors.length} parse errors; first: ${first.message}`;
    throw new HCLParseError(sourceFile, first.range, message, result.errors);
  }
  return toValue(result.body);
}

export function stringify(
  _value: Value,
  _options?: StringifyOptions,
): string {
  throw new NotImplementedError("HCL.stringify");
}

export function parseDocument(
  _source: string,
  _options?: ParseOptions,
): Document {
  throw new NotImplementedError("HCL.parseDocument");
}

const HCL = { parse, stringify, parseDocument, NotImplementedError };
export default HCL;
