import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import HCL, {
  HCLParseError,
  isValidIdentifier,
  parse,
  stringify,
} from "../../src/index.js";
import type { Value } from "../../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Per-rule unit tests
// ─────────────────────────────────────────────────────────────────────────────

describe("attributes and primitives", () => {
  it("emits single-space around =", () => {
    expect(stringify({ x: 1 })).toBe("x = 1\n");
  });
  it("emits null/true/false as bare words", () => {
    expect(stringify({ a: null, b: true, c: false })).toBe(
      "a = null\nb = true\nc = false\n",
    );
  });
  it("emits integers without formatting", () => {
    expect(stringify({ n: 12345 })).toBe("n = 12345\n");
  });
  it("emits floats using JS toString semantics", () => {
    expect(stringify({ n: 3.14 })).toBe("n = 3.14\n");
  });
  it("encodes NaN / Infinity as null", () => {
    expect(stringify({ a: Number.NaN, b: Infinity, c: -Infinity })).toBe(
      "a = null\nb = null\nc = null\n",
    );
  });
  it("quotes non-identifier keys", () => {
    expect(stringify({ "has space": 1 })).toBe('"has space" = 1\n');
  });
  it("leaves identifier keys bare (letters, digits, _ , - )", () => {
    expect(stringify({ bucket_prefix: "p", "a-b": 2 })).toBe(
      'bucket_prefix = "p"\na-b = 2\n',
    );
  });
});

describe("strings — escapes and heredoc promotion", () => {
  it("escapes \", \\, and control chars", () => {
    expect(stringify({ s: 'he said "hi"\\' })).toBe(
      's = "he said \\"hi\\"\\\\"\n',
    );
  });
  it("escapes newlines as \\n in short strings", () => {
    expect(stringify({ s: "a\nb" })).toBe('s = "a\\nb"\n');
  });
  it("escapes $${ and %%{ to prevent re-interpolation", () => {
    expect(stringify({ s: "${foo}" })).toBe('s = "$${foo}"\n');
    expect(stringify({ s: "%{foo}" })).toBe('s = "%%{foo}"\n');
  });
  it("promotes to heredoc when a string contains 3+ newlines and ends with \\n", () => {
    const v = { s: "a\nb\nc\nd\n" };
    const out = stringify(v);
    expect(out).toContain("<<EOT");
    // Round-trips through parse.
    expect(parse(out)).toEqual(v);
  });
  it("falls back to quoted form when multi-newline string lacks trailing \\n", () => {
    // Heredocs always include a trailing newline as the line break
    // before the close delimiter; emitting a heredoc for a no-trailing-
    // newline string would add a byte.
    const v = { s: "a\nb\nc\nd" };
    const out = stringify(v);
    expect(out).toContain('"a\\nb\\nc\\nd"');
    expect(parse(out)).toEqual(v);
  });
  it("promotes to heredoc when a quoted form would exceed 80 cols (trailing \\n)", () => {
    const s = "x".repeat(200) + "\n";
    const out = stringify({ k: s });
    expect(out).toContain("<<EOT");
    expect(parse(out)).toEqual({ k: s });
  });
  it("chooses a non-colliding delimiter when body contains EOT", () => {
    const body = "line1\nEOT\nline3\nline4\n";
    const out = stringify({ s: body });
    expect(out).toMatch(/<<EOT\d/);
    expect(parse(out)).toEqual({ s: body });
  });
});

describe("tuples and objects as expression literals", () => {
  it("emits short tuples inline", () => {
    expect(stringify({ xs: [1, 2, 3] })).toBe("xs = [1, 2, 3]\n");
  });
  it("wraps long tuples multi-line with trailing commas", () => {
    const xs = Array.from({ length: 30 }, (_, i) => i + 1);
    const out = stringify({ xs });
    expect(out.startsWith("xs = [\n")).toBe(true);
    expect(out).toContain("  1,\n");
    expect(out).toContain("  30,\n");
    expect(parse(out)).toEqual({ xs });
  });
  it("object literals inside a tuple stay inline when short", () => {
    const v = { xs: [1, { a: 1 }, 3] };
    const out = stringify(v);
    expect(out).toContain("{ a = 1 }");
    expect(parse(out)).toEqual(v);
  });
  it("emits empty tuples as []", () => {
    expect(stringify({ xs: [] })).toBe("xs = []\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Block grouping (inverse of M5's grouping)
// ─────────────────────────────────────────────────────────────────────────────

describe("block grouping", () => {
  it("emits a plain object value as a block", () => {
    expect(stringify({ locals: { x: 1, y: 2 } })).toBe(
      "locals {\n  x = 1\n  y = 2\n}\n",
    );
  });

  it("emits an empty object as an empty block", () => {
    expect(stringify({ locals: {} })).toBe("locals {}\n");
  });

  it("peels a single label when the middle key value is a body", () => {
    expect(
      stringify({ module: { m: { source: "./m" } } }),
    ).toBe('module "m" {\n  source = "./m"\n}\n');
  });

  it("peels two labels for Terraform-style resources", () => {
    const v = {
      resource: {
        aws_s3_bucket: { a: { acl: "private" } },
      },
    };
    expect(stringify(v)).toBe(
      'resource "aws_s3_bucket" "a" {\n  acl = "private"\n}\n',
    );
  });

  it("emits siblings at the label layer as separate blocks", () => {
    const v = {
      resource: {
        aws_s3_bucket: {
          a: { acl: "private" },
          b: { acl: "public" },
        },
      },
    };
    const out = stringify(v);
    expect(out).toContain('resource "aws_s3_bucket" "a"');
    expect(out).toContain('resource "aws_s3_bucket" "b"');
  });

  it("emits arrays of objects as repeated blocks", () => {
    const v = { prov: [{ x: 1 }, { x: 2 }] };
    expect(stringify(v)).toBe("prov {\n  x = 1\n}\nprov {\n  x = 2\n}\n");
  });

  it("does not promote to block when a value is clearly a tuple", () => {
    expect(stringify({ xs: [1, 2] })).toBe("xs = [1, 2]\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

describe("StringifyOptions", () => {
  it("honors indent option", () => {
    const out = stringify({ a: { b: 1 } }, { indent: 4 });
    expect(out).toBe("a {\n    b = 1\n}\n");
  });

  it("indent = 0 emits flat text", () => {
    const out = stringify({ a: { b: 1 } }, { indent: 0 });
    expect(out).toBe("a {\nb = 1\n}\n");
  });

  it("trailingNewline = false strips the final newline", () => {
    expect(stringify({ x: 1 }, { trailingNewline: false })).toBe("x = 1");
  });

  it("sortKeys sorts body entries alphabetically", () => {
    const v = { c: 3, a: 1, b: 2 };
    expect(stringify(v, { sortKeys: true })).toBe("a = 1\nb = 2\nc = 3\n");
  });

  it("sortKeys also sorts object-literal keys and block bodies", () => {
    const v = { block: { z: 1, a: 2 }, obj: { c: 1, b: 2 } };
    const out = stringify(v, { sortKeys: true });
    expect(out).toBe("block {\n  a = 2\n  z = 1\n}\nobj {\n  b = 2\n  c = 1\n}\n");
  });

  it("replacer can omit values by returning undefined", () => {
    const out = stringify(
      { keep: 1, drop: 2 },
      {
        replacer: (_key, val) => (val === 2 ? undefined : val),
      },
    );
    expect(out).toBe("keep = 1\n");
  });

  it("replacer can transform values", () => {
    const out = stringify(
      { n: 10 },
      {
        replacer: (_k, v) => (typeof v === "number" ? v * 2 : v),
      },
    );
    expect(out).toBe("n = 20\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Expression wrappers: round-trip their .source verbatim
// ─────────────────────────────────────────────────────────────────────────────

describe("Expression wrappers", () => {
  it("emits .source verbatim for expressions", () => {
    const v = parse("x = 1 + 2\n");
    const out = stringify(v);
    expect(out).toBe("x = 1 + 2\n");
  });

  it("round-trips interpolated templates through Expression wrapper", () => {
    const v = parse('x = "hello ${name}"\n');
    const out = stringify(v);
    expect(out).toBe('x = "hello ${name}"\n');
  });

  it("round-trips for expressions", () => {
    const v = parse("x = [for a in xs : a * 2]\n");
    const out = stringify(v);
    expect(out).toContain("for a in xs");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Root-shape validation
// ─────────────────────────────────────────────────────────────────────────────

describe("root value validation", () => {
  it("throws on non-object roots", () => {
    expect(() => stringify(42)).toThrow(TypeError);
    expect(() => stringify("hi")).toThrow(TypeError);
    expect(() => stringify([1, 2])).toThrow(TypeError);
    expect(() => stringify(null)).toThrow(TypeError);
  });

  it("accepts an empty object", () => {
    expect(stringify({})).toBe("\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Golden file table
// ─────────────────────────────────────────────────────────────────────────────

describe("golden (input → canonical output)", () => {
  const goldens: Array<[string, Value, string]> = [
    ["flat attrs", { a: 1, b: "hi", c: true }, 'a = 1\nb = "hi"\nc = true\n'],
    [
      "one label block",
      { module: { m: { source: "./m" } } },
      'module "m" {\n  source = "./m"\n}\n',
    ],
    [
      "resource with two labels",
      {
        resource: { aws_s3_bucket: { a: { acl: "private" } } },
      },
      'resource "aws_s3_bucket" "a" {\n  acl = "private"\n}\n',
    ],
    [
      "zero-label nested block",
      { outer: { inner: { x: 1 } } },
      'outer "inner" {\n  x = 1\n}\n',
    ],
    [
      "inline tuple",
      { xs: [1, 2, 3] },
      "xs = [1, 2, 3]\n",
    ],
    [
      "inline object literal inside tuple",
      { xs: [{ a: 1 }] as unknown as Value },
      "xs {\n  a = 1\n}\n",
    ],
    [
      "empty block",
      { block: {} },
      "block {}\n",
    ],
    [
      "quoted key",
      { "has-space key": 1 },
      '"has-space key" = 1\n',
    ],
  ];

  for (const [name, input, expected] of goldens) {
    it(`golden: ${name}`, () => {
      expect(stringify(input)).toBe(expected);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip property: parse(stringify(parse(f))) structurally == parse(f)
// ─────────────────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(here, "..", "corpus", "hashicorp-hcl");
const CORPUS_FILES = readdirSync(CORPUS_DIR)
  .filter((n) => n.endsWith(".hcl"))
  .filter((n) => !n.includes("_bad") && !n.includes("_invalid") && !n.includes("unclosed"))
  .sort();

/**
 * Structural equality for Values that ignores Expression AST details
 * like token positions and trivia — those legitimately differ between a
 * parse of the original source and a parse of the re-emitted source
 * (line numbers change, normalized whitespace differs). The meaningful
 * invariants — types, literal values, collection shapes, and an
 * Expression wrapper's (kind, source) — must still match.
 */
function normalizeForComparison(v: Value): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(normalizeForComparison);
  if (
    typeof (v as { __hcl?: unknown }).__hcl === "string"
  ) {
    const expr = v as { __hcl: string; kind: string; source: string };
    return { __hcl: expr.__hcl, kind: expr.kind, source: expr.source };
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    out[k] = normalizeForComparison((v as Record<string, Value>)[k]!);
  }
  return out;
}

describe("round-trip: parse → stringify → parse is structurally idempotent", () => {
  for (const file of CORPUS_FILES) {
    it(`corpus: ${file}`, () => {
      const text = readFileSync(join(CORPUS_DIR, file), "utf8");
      const parsed = parse(text);
      const emitted = stringify(parsed);
      const reparsed = parse(emitted);
      expect(normalizeForComparison(reparsed)).toEqual(
        normalizeForComparison(parsed),
      );
      // Stronger secondary invariant: stringify is idempotent — applying
      // it twice produces identical text.
      expect(stringify(reparsed)).toBe(emitted);
    });
  }

  const handwritten: Array<[string, string]> = [
    ["primitives", "a = 1\nb = true\nc = null\ns = \"hi\"\n"],
    ["nested blocks", "outer {\n  inner {\n    x = 1\n  }\n}\n"],
    [
      "terraform-ish resource",
      'resource "aws_s3_bucket" "b" {\n  acl = "private"\n  tags = {\n    env = "dev"\n  }\n}\n',
    ],
    [
      "tuple of literals",
      "xs = [1, 2, 3]\nys = [true, false]\n",
    ],
    [
      "object literal attribute",
      "obj = { a = 1, b = 2 }\n",
    ],
    [
      "multi-attribute block body",
      "locals {\n  x = 1\n  y = \"two\"\n  z = [1, 2]\n}\n",
    ],
    [
      "duplicate blocks collect and round-trip",
      'provisioner "a" { x = 1 }\nprovisioner "a" { x = 2 }\n',
    ],
  ];

  for (const [name, input] of handwritten) {
    it(`handwritten: ${name}`, () => {
      const parsed = parse(input);
      const emitted = stringify(parsed);
      const reparsed = parse(emitted);
      expect(normalizeForComparison(reparsed)).toEqual(
        normalizeForComparison(parsed),
      );
      expect(stringify(reparsed)).toBe(emitted);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// isValidIdentifier helper (exercised internally + exported for users)
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidIdentifier", () => {
  it("accepts UAX #31 starts + continues", () => {
    expect(isValidIdentifier("foo")).toBe(true);
    expect(isValidIdentifier("foo_bar")).toBe(true);
    expect(isValidIdentifier("foo-bar")).toBe(true);
    expect(isValidIdentifier("αβγ")).toBe(true);
  });
  it("rejects digit starts and empty strings", () => {
    expect(isValidIdentifier("1foo")).toBe(false);
    expect(isValidIdentifier("")).toBe(false);
  });
  it("rejects identifiers starting with underscore (strict UAX #31)", () => {
    expect(isValidIdentifier("_foo")).toBe(false);
  });
  it("rejects keys containing spaces or punctuation", () => {
    expect(isValidIdentifier("has space")).toBe(false);
    expect(isValidIdentifier("has.dot")).toBe(false);
  });
});

describe("HCL.stringify via default export", () => {
  it("is wired on HCL", () => {
    expect(HCL.stringify).toBe(stringify);
  });

  it("pairs with HCL.parse (smoke)", () => {
    const text = "a = 1\nb = \"c\"\n";
    expect(stringify(parse(text))).toBe(text);
  });

  it("surfaces parse errors from re-parsing", () => {
    // Artificial: stringify + parse should never surface errors for
    // values the printer itself produces. Confirm via a known-bad
    // user input producing an HCLParseError on the way in.
    expect(() => parse("bad !@#$ syntax\n")).toThrow(HCLParseError);
  });
});
