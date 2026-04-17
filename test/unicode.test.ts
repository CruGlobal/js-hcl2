import { describe, it, expect } from "vitest";
import {
  ID_START_RANGES,
  ID_CONTINUE_RANGES,
  UNICODE_VERSION,
  isIdStart,
  isIdContinue,
} from "../src/unicode.js";

const HYPHEN = 0x002d;

/**
 * Trivial linear-scan reference implementation. The *table* correctness is
 * guaranteed by the generator (which reads the pinned, official Unicode
 * DerivedCoreProperties.txt). These tests verify that the binary-search
 * predicate matches the table — a property that is independent of which
 * Unicode version is pinned.
 */
function linearContains(ranges: Uint32Array, cp: number): boolean {
  for (let i = 0; i < ranges.length; i += 2) {
    if (cp >= ranges[i]! && cp <= ranges[i + 1]!) return true;
  }
  return false;
}

describe("unicode tables", () => {
  it("declares the pinned Unicode version", () => {
    expect(UNICODE_VERSION).toBe("16.0.0");
  });

  it("emits ranges as Uint32Array with even length", () => {
    expect(ID_START_RANGES).toBeInstanceOf(Uint32Array);
    expect(ID_CONTINUE_RANGES).toBeInstanceOf(Uint32Array);
    expect(ID_START_RANGES.length % 2).toBe(0);
    expect(ID_CONTINUE_RANGES.length % 2).toBe(0);
    expect(ID_START_RANGES.length).toBeGreaterThan(0);
    expect(ID_CONTINUE_RANGES.length).toBeGreaterThan(0);
  });

  it("keeps ranges sorted, non-overlapping, and well-formed", () => {
    for (const ranges of [ID_START_RANGES, ID_CONTINUE_RANGES]) {
      let prevEnd = -1;
      for (let i = 0; i < ranges.length; i += 2) {
        const start = ranges[i]!;
        const end = ranges[i + 1]!;
        expect(start).toBeLessThanOrEqual(end);
        expect(start).toBeGreaterThan(prevEnd);
        prevEnd = end;
      }
    }
  });
});

describe("isIdStart / isIdContinue (spec-anchored cases)", () => {
  it("classifies ASCII letters as ID_Start and ID_Continue", () => {
    for (let cp = 0x41; cp <= 0x5a; cp++) {
      expect(isIdStart(cp)).toBe(true);
      expect(isIdContinue(cp)).toBe(true);
    }
    for (let cp = 0x61; cp <= 0x7a; cp++) {
      expect(isIdStart(cp)).toBe(true);
      expect(isIdContinue(cp)).toBe(true);
    }
  });

  it("classifies ASCII digits as ID_Continue but not ID_Start", () => {
    for (let cp = 0x30; cp <= 0x39; cp++) {
      expect(isIdStart(cp)).toBe(false);
      expect(isIdContinue(cp)).toBe(true);
    }
  });

  it("accepts the HCL hyphen extension in ID_Continue only", () => {
    expect(isIdStart(HYPHEN)).toBe(false);
    expect(isIdContinue(HYPHEN)).toBe(true);
  });

  it("rejects ASCII punctuation and whitespace that aren't identifier chars", () => {
    const cps = [0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x28, 0x29, 0x2b, 0x2f];
    for (const cp of cps) {
      expect(isIdStart(cp)).toBe(false);
      expect(isIdContinue(cp)).toBe(false);
    }
  });

  it("classifies stable non-ASCII letter blocks correctly", () => {
    // Spot-check characters that have been ID_Start in every Unicode version
    // since their encoding was assigned, so the assertions are stable across
    // any Unicode version we might pin.
    const idStartCps = [
      0x00c0, // À — Latin-1 Supplement
      0x03b1, // α — Greek Small Letter Alpha
      0x0410, // А — Cyrillic Capital A
      0x05d0, // א — Hebrew Alef
      0x0627, // ا — Arabic Alef
      0x4e2d, // 中 — CJK Ideograph
      0x30a2, // ア — Katakana A
      0x20000, // 𠀀 — CJK Extension B
    ];
    for (const cp of idStartCps) {
      expect(isIdStart(cp)).toBe(true);
      expect(isIdContinue(cp)).toBe(true);
    }
  });

  it("rejects emoji and symbols from identifier classes", () => {
    const nonIdCps = [
      0x1f389, // 🎉 party popper
      0x1f4a9, // 💩 pile of poo
      0x2603, // ☃ snowman
      0x2028, // line separator
    ];
    for (const cp of nonIdCps) {
      expect(isIdStart(cp)).toBe(false);
      expect(isIdContinue(cp)).toBe(false);
    }
  });

  it("handles out-of-range code points", () => {
    expect(isIdStart(-1)).toBe(false);
    expect(isIdStart(0x110000)).toBe(false);
    expect(isIdContinue(-1)).toBe(false);
    expect(isIdContinue(0x110000)).toBe(false);
  });
});

describe("binary-search vs linear-scan", () => {
  it("matches a linear scan of ID_Start across ≥1000 sampled code points", () => {
    const STRIDE = 0x400;
    let checked = 0;
    for (let cp = 0; cp < 0x110000; cp += STRIDE) {
      checked++;
      const expected = linearContains(ID_START_RANGES, cp);
      expect(isIdStart(cp)).toBe(expected);
    }
    expect(checked).toBeGreaterThanOrEqual(1000);
  });

  it("matches a linear scan of ID_Continue across ≥1000 sampled code points", () => {
    const STRIDE = 0x400;
    let checked = 0;
    for (let cp = 0; cp < 0x110000; cp += STRIDE) {
      checked++;
      const expected = linearContains(ID_CONTINUE_RANGES, cp);
      expect(isIdContinue(cp)).toBe(expected);
    }
    expect(checked).toBeGreaterThanOrEqual(1000);
  });

  it("matches a linear scan at every range boundary (start, end, ±1)", () => {
    for (const [predicate, ranges] of [
      [isIdStart, ID_START_RANGES],
      [isIdContinue, ID_CONTINUE_RANGES],
    ] as const) {
      const boundaries = new Set<number>();
      for (let i = 0; i < ranges.length; i += 2) {
        boundaries.add(ranges[i]!);
        boundaries.add(ranges[i + 1]!);
        if (ranges[i]! > 0) boundaries.add(ranges[i]! - 1);
        if (ranges[i + 1]! < 0x10ffff) boundaries.add(ranges[i + 1]! + 1);
      }
      for (const cp of boundaries) {
        expect(predicate(cp)).toBe(linearContains(ranges, cp));
      }
    }
  });
});
