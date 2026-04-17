/**
 * Parse-time error reporting. Every error carries its source position and a
 * one-line snippet with a caret marker so messages are immediately useful in
 * a terminal, editor, or CI log.
 */

import type { Range, SourceFile } from "./source.js";

/**
 * Thrown (or collected) when HCL parsing fails. When the caller passes
 * `bail: false`, the parser gathers multiple errors and throws a single
 * aggregate `HCLParseError` whose `errors` array contains the individual
 * failures; the aggregate's own position fields point at the first error
 * for convenience.
 */
export class HCLParseError extends Error {
  readonly filename: string;
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  readonly snippet: string;
  readonly range: Range;
  readonly errors: readonly HCLParseError[];

  constructor(
    source: SourceFile,
    range: Range,
    message: string,
    errors: readonly HCLParseError[] = [],
  ) {
    super(message);
    this.name = "HCLParseError";
    this.filename = source.filename;
    this.line = range.start.line;
    this.column = range.start.column;
    this.offset = range.start.offset;
    this.range = range;
    this.errors = errors;
    this.snippet = formatSnippet(source, range);
  }
}

/**
 * Render a one-line diagnostic snippet with a caret marker under the range.
 * The returned string does not end in a newline.
 *
 * Example output:
 *
 * ```
 *   3 | foo = bar baz
 *     |           ^^^
 * ```
 *
 * Ranges spanning multiple lines are truncated to the first line; the caret
 * extends to the end of that line.
 */
export function formatSnippet(source: SourceFile, range: Range): string {
  const { line, column } = range.start;
  const lineText = source.lineText(line);
  const gutter = String(line).padStart(GUTTER_WIDTH, " ");
  const pad = " ".repeat(GUTTER_WIDTH);

  const startCol = column;
  const endCol =
    range.end.line === line
      ? Math.max(range.end.column, column + 1)
      : columnCountOf(lineText) + 2; // underline through end of line + 1

  const leading = " ".repeat(Math.max(0, startCol - 1));
  const caret = "^".repeat(Math.max(1, endCol - startCol));

  return `${gutter} | ${lineText}\n${pad} | ${leading}${caret}`;
}

const GUTTER_WIDTH = 3;

/** Count Unicode code points in a string. Matches source.ts column semantics. */
function columnCountOf(text: string): number {
  let count = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        count++;
        i += 2;
        continue;
      }
    }
    count++;
    i++;
  }
  return count;
}
