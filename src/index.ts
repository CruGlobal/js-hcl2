/**
 * @cruglobal/js-hcl2 — HashiCorp Configuration Language v2 parser and encoder.
 *
 * The top-level parse/stringify/parseDocument functions are stubs until the
 * lexer (M2), parser (M3–M4), value projection (M5), canonical printer (M6),
 * and document round-trip (M7) land. The supporting types and utilities
 * re-exported below are production code as of M1.
 */

export { HCLParseError, formatSnippet } from "./errors.js";
export type { Position, Range } from "./source.js";
export { SourceFile } from "./source.js";
export { lex, Lexer } from "./lexer/lexer.js";
export { TokenKind } from "./lexer/token.js";
export type { Token } from "./lexer/token.js";
export { parse as parseBody, Parser } from "./parser/parser.js";
export { print } from "./parser/print.js";
export type { ParserOptions, ParseResult } from "./parser/parser.js";
export type {
  Node,
  NodeKind,
  BodyNode,
  AttributeNode,
  BlockNode,
  BlockLabelsNode,
  ExpressionNode,
  LabelInfo,
} from "./parser/nodes.js";
export { isToken } from "./parser/nodes.js";

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented yet (pre-alpha)`);
    this.name = "NotImplementedError";
  }
}

export interface ParseOptions {
  filename?: string;
  bail?: boolean;
}

export interface StringifyOptions {
  indent?: number;
  quotes?: "double";
  trailingNewline?: boolean;
  sortKeys?: boolean;
  replacer?: (key: string, value: unknown) => unknown;
}

export type Value =
  | null
  | boolean
  | number
  | string
  | readonly Value[]
  | { readonly [key: string]: Value };

export interface Document {
  toString(): string;
  toValue(): Value;
}

export function parse(_source: string, _options?: ParseOptions): Value {
  throw new NotImplementedError("HCL.parse");
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
