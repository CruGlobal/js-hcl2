/**
 * @cruglobal/js-hcl2 — HashiCorp Configuration Language v2 parser and encoder.
 *
 * This file is a stub placeholder created by milestone M0. Real
 * implementations land in M2 (lexer), M3–M4 (parser), M5 (Value projection),
 * M6 (canonical printer), and M7 (Document / lossless round-trip).
 */

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
