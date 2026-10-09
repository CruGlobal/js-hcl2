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
 * The Value generators deliberately avoid inputs whose structure the
 * Value layer collapses ambiguously (e.g. tuple-of-plain-objects, which
 * the printer emits as repeated blocks). A separate property generates
 * HCL text instead, so it covers those shapes as `parse` returns them.
 * The milestone bar is ≥1000 generated inputs across the property tests.
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

/** Label text built from fragments that need escaping in a quoted label. */
const escapedLabel = fc
  .array(
    fc.constantFrom(
      "a", "Z", " ", '"', "\\", "\n", "\r", "\t", "\u0001",
      "$", "%", "{", "}", "${", "%{", "$${", "é", "😀",
    ),
    { minLength: 1, maxLength: 8 },
  )
  .map((parts) => parts.join(""));

// ─────────────────────────────────────────────────────────────────────────────
// Generated HCL text. The Value generators above avoid shapes the Value
// layer can't tell apart (one-item lists of objects, objects that could
// be blocks or attributes). Generating text instead covers exactly the
// Values `parse` can return, so every one of them must round-trip.
// ─────────────────────────────────────────────────────────────────────────────

/** Object keys and labels: identifiers mixed with keys that need quotes. */
const anyKey = fc.oneof(
  identKey,
  fc.constantFrom(
    "a.b", "roles/viewer", "1a", "has space", "", "for", "null", "in",
    "if", "true", "é", "😀", "${x}", "%{y}", 'q"uote', "back\\slash",
    "a-b", "_u",
  ),
);

/** `s` as an HCL quoted string, with `${` and `%{` escaped. */
function hclString(s: string): string {
  return JSON.stringify(s).replace(/\$\{/g, "$$$${").replace(/%\{/g, "%%{");
}

const literalText = fc.letrec((tie) => ({
  value: fc.oneof(
    { depthSize: "small" },
    fc.constantFrom("true", "false", "null"),
    fc.nat(1000).map(String),
    safeString.map(hclString),
    tie("tuple"),
    tie("object"),
  ),
  tuple: fc
    .array(tie("value") as fc.Arbitrary<string>, { maxLength: 3 })
    .map((items) => `[${items.join(", ")}]`),
  object: fc
    .uniqueArray(fc.tuple(anyKey, tie("value") as fc.Arbitrary<string>), {
      maxLength: 4,
      selector: ([k]) => k,
    })
    .map(
      (items) =>
        `{ ${items.map(([k, v]) => `${hclString(k)} = ${v}`).join(", ")} }`,
    ),
})).value as fc.Arbitrary<string>;

const expressionText = fc.constantFrom(
  "var.x",
  '"${var.y}-z"',
  "local.z[0]",
  "f(1)",
  "[for v in var.l : v]",
);

/**
 * A body of attributes and blocks. Attribute names start with `a_` and
 * block types with `b`, so the two never share a key. The digit in a
 * block type is its label count, so blocks of one type never nest under
 * each other's labels. Repeated types and labels make lists of blocks.
 */
const bodyText = fc.letrec((tie) => ({
  body: fc
    .record({
      attrs: fc.uniqueArray(
        fc.tuple(identKey, fc.oneof(literalText, literalText, expressionText)),
        { maxLength: 4, selector: ([k]) => k },
      ),
      blocks: fc.array(tie("block") as fc.Arbitrary<string>, {
        maxLength: 3,
      }),
    })
    .map(({ attrs, blocks }) =>
      [...attrs.map(([k, v]) => `a_${k} = ${v}`), ...blocks].join("\n"),
    ),
  block: fc
    .tuple(
      fc.integer({ min: 0, max: 2 }),
      fc.constantFrom("x", "y"),
      fc.array(anyKey, { minLength: 2, maxLength: 2 }),
      fc.oneof(
        { depthSize: "small" },
        fc.constant(""),
        tie("body") as fc.Arbitrary<string>,
      ),
    )
    .map(([n, t, labels, body]) => {
      const header = labels.slice(0, n).map((l) => ` ${hclString(l)}`);
      return `b${n}${t}${header.join("")} {\n${body}\n}`;
    }),
})).body;

describe("property: any parsed body round-trips through stringify", () => {
  it(`holds over ${RUNS_MAIN} generated HCL files`, () => {
    fc.assert(
      fc.property(bodyText, (text) => {
        const parsed = parse(`${text}\n`);
        const once = stringify(parsed);
        const reparsed = parse(once);
        expect(normalize(reparsed)).toEqual(normalize(parsed));
        expect(stringify(reparsed)).toBe(once);
      }),
      { numRuns: RUNS_MAIN },
    );
  });
});

describe("property: block labels that need escapes round-trip", () => {
  it(`holds over ${RUNS_SMALL} generated label pairs`, () => {
    fc.assert(
      fc.property(identKey, escapedLabel, escapedLabel, (type, l1, l2) => {
        const body = { [type]: { [l1]: { [l2]: { k: 1 } } } };
        expect(parse(stringify(body))).toEqual(body);
      }),
      { numRuns: RUNS_SMALL },
    );
  });
});
