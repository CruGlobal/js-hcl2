import { describe, it, expect } from "vitest";
import { SourceFile } from "../src/source.js";

describe("SourceFile", () => {
  describe("construction + line index", () => {
    it("treats an empty file as one empty line", () => {
      const f = new SourceFile("");
      expect(f.lineCount).toBe(1);
      expect(f.lineStarts).toEqual([0]);
    });

    it("records one line start per LF", () => {
      const f = new SourceFile("a\nb\nc");
      expect(f.lineCount).toBe(3);
      expect(f.lineStarts).toEqual([0, 2, 4]);
    });

    it("treats CRLF as a single terminator", () => {
      const f = new SourceFile("a\r\nb\r\nc");
      expect(f.lineCount).toBe(3);
      expect(f.lineStarts).toEqual([0, 3, 6]);
    });

    it("treats bare CR as a line terminator", () => {
      const f = new SourceFile("a\rb\rc");
      expect(f.lineCount).toBe(3);
      expect(f.lineStarts).toEqual([0, 2, 4]);
    });

    it("handles mixed line endings", () => {
      const f = new SourceFile("a\nb\r\nc\rd");
      expect(f.lineCount).toBe(4);
      expect(f.lineStarts).toEqual([0, 2, 5, 7]);
    });

    it("records a virtual line start just past the end for a trailing newline", () => {
      const f = new SourceFile("a\n");
      expect(f.lineCount).toBe(2);
      expect(f.lineStarts).toEqual([0, 2]);
    });
  });

  describe("positionOf", () => {
    it("returns 1,1 for offset 0 of a non-empty file", () => {
      const f = new SourceFile("hello");
      expect(f.positionOf(0)).toEqual({ line: 1, column: 1, offset: 0 });
    });

    it("advances column within a line", () => {
      const f = new SourceFile("hello");
      expect(f.positionOf(3)).toEqual({ line: 1, column: 4, offset: 3 });
    });

    it("resets column to 1 after a newline", () => {
      const f = new SourceFile("ab\ncd");
      expect(f.positionOf(3)).toEqual({ line: 2, column: 1, offset: 3 });
      expect(f.positionOf(5)).toEqual({ line: 2, column: 3, offset: 5 });
    });

    it("counts surrogate pairs as one column but two offset units", () => {
      const f = new SourceFile("🎉x");
      // "🎉" is U+1F389, encoded as two UTF-16 code units.
      expect(f.positionOf(2)).toEqual({ line: 1, column: 2, offset: 2 });
      expect(f.positionOf(3)).toEqual({ line: 1, column: 3, offset: 3 });
    });

    it("accepts offset == text.length as end-of-file", () => {
      const f = new SourceFile("abc");
      expect(f.positionOf(3)).toEqual({ line: 1, column: 4, offset: 3 });
    });

    it("throws RangeError for negative or out-of-bounds offsets", () => {
      const f = new SourceFile("abc");
      expect(() => f.positionOf(-1)).toThrow(RangeError);
      expect(() => f.positionOf(4)).toThrow(RangeError);
      expect(() => f.positionOf(1.5)).toThrow(RangeError);
    });

    it("handles CRLF correctly in positionOf", () => {
      const f = new SourceFile("a\r\nb");
      expect(f.positionOf(3)).toEqual({ line: 2, column: 1, offset: 3 });
    });
  });

  describe("lineStartOffset + lineText", () => {
    it("returns the starting offset of each 1-based line", () => {
      const f = new SourceFile("foo\nbar\nbaz");
      expect(f.lineStartOffset(1)).toBe(0);
      expect(f.lineStartOffset(2)).toBe(4);
      expect(f.lineStartOffset(3)).toBe(8);
    });

    it("returns line text without the trailing newline", () => {
      const f = new SourceFile("foo\nbar\r\nbaz");
      expect(f.lineText(1)).toBe("foo");
      expect(f.lineText(2)).toBe("bar");
      expect(f.lineText(3)).toBe("baz");
    });

    it("returns the final line even if there is no trailing newline", () => {
      const f = new SourceFile("a\nb");
      expect(f.lineText(2)).toBe("b");
    });

    it("returns an empty string for the virtual line after a trailing newline", () => {
      const f = new SourceFile("a\n");
      expect(f.lineText(2)).toBe("");
    });

    it("throws RangeError for out-of-range line numbers", () => {
      const f = new SourceFile("abc");
      expect(() => f.lineStartOffset(0)).toThrow(RangeError);
      expect(() => f.lineStartOffset(2)).toThrow(RangeError);
    });
  });

  describe("filename", () => {
    it("uses <input> as the default", () => {
      const f = new SourceFile("x");
      expect(f.filename).toBe("<input>");
    });

    it("preserves an explicit filename", () => {
      const f = new SourceFile("x", "main.tf");
      expect(f.filename).toBe("main.tf");
    });
  });
});
