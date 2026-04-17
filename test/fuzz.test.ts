/**
 * Property-based fuzz tests for the Value ⇄ HCL round-trip.
 *
 * Generator strategy:
 *   1. Build random `Value` trees from a small alphabet — primitives,
 *      valid-identifier keys, bounded-depth nested objects and arrays.
 *   2. Assert `parse(stringify(v))` is structurally equal to `v` under
 *      an Expression-aware normalizer.
 *   3. Separately assert that `stringify` is idempotent — applying it
 *      twice yields identical text — which shakes out deterministic
 *      output across reorderings the printer doesn't preserve.
 *
 * The generators deliberately avoid inputs whose structure the Value
 * layer collapses ambiguously (e.g. tuple-of-plain-objects, which the
 * printer emits as repeated blocks). The milestone bar is ≥1000
 * generated inputs across the property tests.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isExpression, parse, stringify } from "../src/index.js";
import type { Value } from "../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Generators
// ─────────────────────────────────────────────────────────────────────────────

/** Strings that are safe as HCL string content — ASCII printable + common
 *  escapes, avoiding the template markers `${` and `%{` which round-trip
 *  through escape sequences and could inflate size. */
const safeString = fc.string({
  unit: fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)),
  minLength: 0,
  maxLength: 20,
});

/** Keys that round-trip cleanly as HCL body keys. We restrict to plain
 *  ASCII identifiers so every emitted key is a bare IDENT — quoted keys
 *  are correct but the printer's `sortKeys: false` output order becomes
 *  sensitive to lexical sort differences between JS and HCL parsers. */
const identKey = fc
  .stringMatching(/^[a-z][a-z0-9_-]{0,8}$/)
  .filter((s) => !RESERVED.has(s));

const RESERVED = new Set(["true", "false", "null", "for", "if", "in", "else", "endif", "endfor"]);

/** Non-negative finite JS numbers. The fuzz restricts to positives
 *  because the Value layer (by design — see docs/design.md §3.1 and
 *  §6.4) parses `-n` as a UnaryOp expression rather than folding the
 *  sign into a numeric literal. Testing negative round-trip via the
 *  Value path would need constant-folding, which v1.0 explicitly
 *  defers to the evaluator milestone. */
const finiteNumber = fc.double({
  min: 0,
  max: 1e6,
  noNaN: true,
  noDefaultInfinity: true,
});

const primitiveValue: fc.Arbitrary<Value> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  finiteNumber,
  safeString,
);

/** Tuples of primitive values only — avoids the "tuple of plain objects
 *  → repeated blocks" promotion path. */
const primitiveTuple: fc.Arbitrary<Value> = fc.array(primitiveValue, {
  maxLength: 6,
});


/**
 * Generate a nested "body tree" — the JS shape that corresponds to a
 * valid HCL body. At each level we choose between:
 *   - primitive or primitive-tuple (attribute)
 *   - plain object of leafs (block body)
 *   - labeled-block shape (one more level of identifier keys containing
 *     plain-object values)
 */
const bodyTree: fc.Arbitrary<Record<string, Value>> = fc.letrec((tie) => ({
  attrValue: fc.oneof(primitiveValue, primitiveTuple),
  blockBody: fc.dictionary(identKey, tie("attrValue"), { maxKeys: 4 }),
  labeledBody: fc.dictionary(
    identKey,
    tie("blockBody") as fc.Arbitrary<Record<string, Value>>,
    { maxKeys: 3 },
  ),
  root: fc.dictionary(
    identKey,
    fc.oneof(tie("attrValue"), tie("blockBody"), tie("labeledBody")),
    { maxKeys: 5 },
  ),
})).root as fc.Arbitrary<Record<string, Value>>;

// ─────────────────────────────────────────────────────────────────────────────
// Comparison helpers
// ─────────────────────────────────────────────────────────────────────────────

function normalize(v: Value): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(normalize);
  if (isExpression(v)) {
    return { __hcl: v.__hcl, kind: v.kind, source: v.source };
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    out[k] = normalize((v as Record<string, Value>)[k]!);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Properties
// ─────────────────────────────────────────────────────────────────────────────

// 500 + 300 + 300 + 200 = 1300 generated inputs total, exceeding the
// milestone's 1000 bar.
const RUNS_MAIN = 500;
const RUNS_SMALL = 300;

describe("property: parse ∘ stringify is idempotent on bodies", () => {
  it(`holds over ${RUNS_MAIN} generated body trees`, () => {
    fc.assert(
      fc.property(bodyTree, (body) => {
        const text = stringify(body);
        const parsed = parse(text);
        expect(normalize(parsed)).toEqual(normalize(body));
      }),
      { numRuns: RUNS_MAIN },
    );
  });
});

describe("property: stringify is idempotent on body trees", () => {
  it(`holds over ${RUNS_SMALL} generated inputs`, () => {
    fc.assert(
      fc.property(bodyTree, (body) => {
        const once = stringify(body);
        const twice = stringify(parse(once));
        expect(twice).toBe(once);
      }),
      { numRuns: RUNS_SMALL },
    );
  });
});

describe("property: parse handles attribute-only bodies", () => {
  it(`holds over ${RUNS_SMALL} generated flat records`, () => {
    fc.assert(
      fc.property(
        fc.dictionary(identKey, primitiveValue, { maxKeys: 10 }),
        (obj) => {
          const text = stringify(obj);
          const parsed = parse(text);
          expect(normalize(parsed)).toEqual(normalize(obj));
        },
      ),
      { numRuns: RUNS_SMALL },
    );
  });
});

describe("property: stringify handles primitive tuples", () => {
  it(`holds over 200 generated arrays`, () => {
    fc.assert(
      fc.property(
        fc.dictionary(identKey, primitiveTuple, { maxKeys: 6 }),
        (obj) => {
          const text = stringify(obj);
          const parsed = parse(text);
          expect(normalize(parsed)).toEqual(normalize(obj));
        },
      ),
      { numRuns: 200 },
    );
  });
});
