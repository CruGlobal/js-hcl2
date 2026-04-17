import { describe, it, expect } from "vitest";
import { HCLParseError, formatSnippet } from "../src/errors.js";
import { SourceFile } from "../src/source.js";

function rangeAt(
  source: SourceFile,
  startOffset: number,
  endOffset: number,
) {
  return {
    start: source.positionOf(startOffset),
    end: source.positionOf(endOffset),
  };
}

describe("HCLParseError", () => {
  it("copies position fields from the range start", () => {
    const source = new SourceFile("foo = bar\n", "main.tf");
    const range = rangeAt(source, 6, 9);
    const err = new HCLParseError(source, range, "unknown identifier 'bar'");

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("HCLParseError");
    expect(err.message).toBe("unknown identifier 'bar'");
    expect(err.filename).toBe("main.tf");
    expect(err.line).toBe(1);
    expect(err.column).toBe(7);
    expect(err.offset).toBe(6);
    expect(err.errors).toEqual([]);
  });

  it("aggregates child errors when provided", () => {
    const source = new SourceFile("a\nb\n");
    const first = new HCLParseError(
      source,
      rangeAt(source, 0, 1),
      "bad a",
    );
    const second = new HCLParseError(
      source,
      rangeAt(source, 2, 3),
      "bad b",
    );
    const agg = new HCLParseError(
      source,
      rangeAt(source, 0, 1),
      "2 parse errors",
      [first, second],
    );
    expect(agg.errors).toHaveLength(2);
    expect(agg.errors[0]!.message).toBe("bad a");
    expect(agg.errors[1]!.message).toBe("bad b");
  });

  it("populates snippet on construction", () => {
    const source = new SourceFile("foo = bar baz\n");
    const err = new HCLParseError(
      source,
      rangeAt(source, 10, 13),
      "extra token",
    );
    expect(err.snippet).toContain("foo = bar baz");
    expect(err.snippet).toContain("^^^");
  });
});

describe("formatSnippet", () => {
  it("renders a single-line range with carets under the offending text", () => {
    const source = new SourceFile("foo = bar baz\n");
    const snippet = formatSnippet(source, rangeAt(source, 10, 13));
    const lines = snippet.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("  1 | foo = bar baz");
    expect(lines[1]).toBe("    |           ^^^");
  });

  it("right-aligns the gutter across multi-digit line numbers", () => {
    const source = new SourceFile("\n".repeat(99) + "target\n");
    const snippet = formatSnippet(source, rangeAt(source, 99, 105));
    const lines = snippet.split("\n");
    expect(lines[0]).toBe("100 | target");
    expect(lines[1]).toBe("    | ^^^^^^");
  });

  it("uses at least one caret for zero-width ranges", () => {
    const source = new SourceFile("foo\n");
    const snippet = formatSnippet(source, rangeAt(source, 3, 3));
    const lines = snippet.split("\n");
    expect(lines[1]).toBe("    |    ^");
  });

  it("truncates multi-line ranges to the first line", () => {
    const source = new SourceFile("abc\ndef\n");
    const snippet = formatSnippet(source, rangeAt(source, 1, 6));
    const lines = snippet.split("\n");
    expect(lines[0]).toBe("  1 | abc");
    // Caret runs from column 2 through the end-of-line sentinel (line width + 1).
    expect(lines[1]).toBe("    |  ^^^");
  });

  it("positions the caret using code-point columns, not UTF-16 offsets", () => {
    const source = new SourceFile("🎉bad\n");
    // "🎉" occupies UTF-16 offsets 0..1 but one visual column.
    // "bad" is at offsets 2..4 and columns 2..4.
    const snippet = formatSnippet(source, rangeAt(source, 2, 5));
    const lines = snippet.split("\n");
    expect(lines[0]).toBe("  1 | 🎉bad");
    expect(lines[1]).toBe("    |  ^^^");
  });
});
