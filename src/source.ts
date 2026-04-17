/**
 * Source position and range primitives shared by the lexer, parser, and
 * error-reporting paths.
 *
 * Offsets are UTF-16 code units (matching `String.prototype.slice` and
 * `charCodeAt`). Columns are 1-based Unicode code points, so a multi-code-
 * unit grapheme like "🎉" counts as one column even though it occupies two
 * UTF-16 code units of offset.
 */

/** A single point in source text. */
export interface Position {
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column, in Unicode code points. */
  readonly column: number;
  /** 0-based offset in UTF-16 code units. */
  readonly offset: number;
}

/** An inclusive-start, exclusive-end span of source text. */
export interface Range {
  readonly start: Position;
  readonly end: Position;
}

/** Default filename used when a caller doesn't provide one. */
export const ANONYMOUS_FILENAME = "<input>";

/**
 * Wraps a source string with a precomputed line-offset index so that
 * `positionOf(offset)` runs in O(log lines) amortized. Constructing a
 * SourceFile is one linear pass over the text.
 *
 * Recognised line terminators: LF (`\n`), CRLF (`\r\n`), and bare CR (`\r`).
 * HCL2's spec only names LF and CRLF, but bare CR is accepted for robustness
 * against files that crossed a Classic-Mac-era checkout.
 */
export class SourceFile {
  readonly filename: string;
  readonly text: string;

  /**
   * UTF-16 offsets of each line's first character. Always starts with 0,
   * and contains one entry per line. `lineStarts.length` equals the number
   * of lines. For a file ending in a newline, the final entry points just
   * past the end of `text`.
   */
  readonly lineStarts: readonly number[];

  constructor(text: string, filename: string = ANONYMOUS_FILENAME) {
    this.text = text;
    this.filename = filename;
    this.lineStarts = computeLineStarts(text);
  }

  /** Number of lines in the file. Always at least 1. */
  get lineCount(): number {
    return this.lineStarts.length;
  }

  /**
   * Convert a UTF-16 offset to a full Position. Throws RangeError if the
   * offset is outside [0, text.length]. An offset equal to text.length is
   * valid and represents end-of-file.
   */
  positionOf(offset: number): Position {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.text.length) {
      throw new RangeError(
        `offset ${offset} is out of range [0, ${this.text.length}]`,
      );
    }
    const lineIdx = findLineIndex(this.lineStarts, offset);
    const lineStart = this.lineStarts[lineIdx]!;
    const column = countCodePoints(this.text, lineStart, offset) + 1;
    return { line: lineIdx + 1, column, offset };
  }

  /** 0-based offset of the first character of `line` (1-based). */
  lineStartOffset(line: number): number {
    if (line < 1 || line > this.lineCount) {
      throw new RangeError(
        `line ${line} is out of range [1, ${this.lineCount}]`,
      );
    }
    return this.lineStarts[line - 1]!;
  }

  /**
   * Returns the text of the given 1-based line, excluding the trailing
   * line terminator. Works for the last line even if the file has no final
   * newline.
   */
  lineText(line: number): string {
    const start = this.lineStartOffset(line);
    const end =
      line < this.lineCount
        ? this.lineStarts[line]!
        : this.text.length;
    return stripTrailingNewline(this.text.slice(start, end));
  }
}

/**
 * One linear pass to identify every line terminator and record the offset
 * that follows it. Handles LF, CRLF (as a single terminator), and bare CR.
 */
function computeLineStarts(text: string): number[] {
  const starts: number[] = [0];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 0x0a /* LF */) {
      starts.push(i + 1);
      i++;
    } else if (c === 0x0d /* CR */) {
      if (i + 1 < n && text.charCodeAt(i + 1) === 0x0a) {
        starts.push(i + 2);
        i += 2;
      } else {
        starts.push(i + 1);
        i++;
      }
    } else {
      i++;
    }
  }
  return starts;
}

/**
 * Binary search for the largest index `i` such that `lineStarts[i] <= offset`.
 * Returns a value in [0, lineStarts.length - 1].
 */
function findLineIndex(lineStarts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Count Unicode code points in `text[start, end)`. Each surrogate pair
 * contributes a single code point; every other UTF-16 unit contributes one.
 */
function countCodePoints(text: string, start: number, end: number): number {
  let count = 0;
  let i = start;
  while (i < end) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < end) {
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

function stripTrailingNewline(line: string): string {
  if (line.endsWith("\r\n")) return line.slice(0, -2);
  if (line.endsWith("\n") || line.endsWith("\r")) return line.slice(0, -1);
  return line;
}
