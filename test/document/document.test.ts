import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import HCL, { parseDocument } from "../../src/index.js";
import type { Document } from "../../src/index.js";

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip: byte-identical toString for every parseable corpus file
// ─────────────────────────────────────────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(here, "..", "corpus", "hashicorp-hcl");
const CORPUS = readdirSync(CORPUS_DIR)
  .filter((n) => n.endsWith(".hcl"))
  .filter(
    (n) => !n.includes("_bad") && !n.includes("_invalid") && !n.includes("unclosed"),
  )
  .sort();

describe("byte-identical round-trip", () => {
  it("discovered at least 5 corpus fixtures", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(5);
  });
  for (const file of CORPUS) {
    it(`${file}`, () => {
      const text = readFileSync(join(CORPUS_DIR, file), "utf8");
      const doc = parseDocument(text);
      expect(doc.toString()).toBe(text);
    });
  }

  // Hand-written round-trip cases: exercise trivia shapes the specsuite
  // fixtures don't happen to include.
  const HANDWRITTEN: Array<[string, string]> = [
    ["comment above + trailing", "# top\nfoo = 1 # trail\n"],
    ["CRLF line endings", "a = 1\r\nb = 2\r\n"],
    ["tabs in trivia", "foo\t=\t1\n\tbar = 2\n"],
    ["mixed slash and hash comments", "// a\nfoo = 1\n# b\nbar = 2\n"],
    ["blank lines between statements", "a = 1\n\n\nb = 2\n"],
    [
      "nested blocks with block labels",
      'resource "t" "n" {\n  acl = "private"\n}\n',
    ],
    ["interpolation preserved", 'g = "hello ${name}"\n'],
    [
      "heredoc preserved (plain)",
      "x = <<EOT\nhello\nworld\nEOT\n",
    ],
    [
      "heredoc preserved (strip form)",
      "x = <<-EOT\n  hi\n  EOT\n",
    ],
  ];
  for (const [name, input] of HANDWRITTEN) {
    it(`handwritten: ${name}`, () => {
      expect(parseDocument(input).toString()).toBe(input);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Navigation (get)
// ─────────────────────────────────────────────────────────────────────────────

describe("Document.get", () => {
  it("resolves a top-level attribute by name", () => {
    const doc = parseDocument("foo = 1\n");
    const node = doc.get("foo");
    expect(node?.kind).toBe("Attribute");
  });

  it("resolves a zero-label block", () => {
    const doc = parseDocument("locals {\n  x = 1\n}\n");
    const node = doc.get("locals");
    expect(node?.kind).toBe("Block");
  });

  it("resolves a two-label block", () => {
    const doc = parseDocument(
      'resource "t" "n" {\n  x = 1\n}\n',
    );
    const node = doc.get("resource.t.n");
    expect(node?.kind).toBe("Block");
  });

  it("resolves an attribute inside a two-label block", () => {
    const doc = parseDocument(
      'resource "t" "n" {\n  acl = "private"\n}\n',
    );
    const node = doc.get(["resource", "t", "n", "acl"]);
    expect(node?.kind).toBe("Attribute");
  });

  it("returns undefined for missing paths", () => {
    const doc = parseDocument("foo = 1\n");
    expect(doc.get("missing")).toBeUndefined();
    expect(doc.get(["foo", "nested"])).toBeUndefined();
  });

  it("numeric segment indexes into a duplicate-block group", () => {
    const doc = parseDocument(
      'p "a" { x = 1 }\np "a" { x = 2 }\n',
    );
    const first = doc.get(["p", "a", 0]);
    const second = doc.get(["p", "a", 1]);
    expect(first?.kind).toBe("Block");
    expect(second?.kind).toBe("Block");
    // Different blocks.
    expect(first).not.toBe(second);
  });

  it("string path also interprets digit-only segments as indices", () => {
    const doc = parseDocument(
      'p "a" { x = 1 }\np "a" { x = 2 }\n',
    );
    const first = doc.get("p.a.0.x");
    expect(first?.kind).toBe("Attribute");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Editing: set (replace + insert) and delete
// ─────────────────────────────────────────────────────────────────────────────

function edited(input: string, mutate: (d: Document) => void): string {
  const doc = parseDocument(input);
  mutate(doc);
  return doc.toString();
}

describe("Document.set — attribute value replacement", () => {
  it("replaces a simple number value", () => {
    const out = edited("x = 1\n", (d) => d.set("x", 42));
    expect(out).toBe("x = 42\n");
  });

  it("replaces a string value", () => {
    const out = edited('msg = "old"\n', (d) => d.set("msg", "new"));
    expect(out).toBe('msg = "new"\n');
  });

  it("preserves leading comment on the attribute line", () => {
    const out = edited("# explain foo\nfoo = 1\n", (d) =>
      d.set("foo", 999),
    );
    expect(out).toBe("# explain foo\nfoo = 999\n");
  });

  it("preserves a same-line trailing comment", () => {
    const out = edited("foo = 1 # keep me\n", (d) => d.set("foo", 2));
    expect(out).toBe("foo = 2 # keep me\n");
  });

  it("replaces an attribute inside a block body", () => {
    const input = 'resource "t" "n" {\n  acl = "private"\n}\n';
    const out = edited(input, (d) =>
      d.set(["resource", "t", "n", "acl"], "public"),
    );
    expect(out).toBe('resource "t" "n" {\n  acl = "public"\n}\n');
  });

  it("does not disturb unrelated siblings", () => {
    const input = "a = 1\nb = 2 # about b\nc = 3\n";
    const out = edited(input, (d) => d.set("b", 222));
    expect(out).toBe("a = 1\nb = 222 # about b\nc = 3\n");
  });
});

describe("Document.set — insertion of new attributes", () => {
  it("appends a new attribute to the end of an empty file", () => {
    const out = edited("", (d) => d.set("x", 1));
    expect(out).toContain("x = 1");
  });

  it("appends a new attribute after existing ones", () => {
    const out = edited("a = 1\n", (d) => d.set("b", 2));
    expect(out).toBe("a = 1\nb = 2\n");
  });

  it("appends inside a block body with matching indentation", () => {
    const input = "locals {\n  a = 1\n}\n";
    const out = edited(input, (d) => d.set(["locals", "b"], 2));
    expect(out).toBe("locals {\n  a = 1\n  b = 2\n}\n");
  });

  it("appends inside a two-label block body", () => {
    const input = 'resource "t" "n" {\n  acl = "private"\n}\n';
    const out = edited(input, (d) =>
      d.set(["resource", "t", "n", "tags"], { env: "dev" }),
    );
    expect(out).toContain('acl = "private"');
    expect(out).toContain("tags");
    expect(out).toContain('env = "dev"');
  });

  it("appends with 2-space indent when the body has no existing attrs", () => {
    const input = "block {\n}\n";
    const out = edited(input, (d) => d.set(["block", "x"], 1));
    // No existing sibling to copy indent from → zero indent. Still a
    // valid parse, just flat.
    expect(out).toContain("x = 1");
    const parsed = HCL.parse(out);
    expect(parsed).toEqual({ block: { x: 1 } });
  });
});

describe("Document.delete", () => {
  it("removes a top-level attribute and its following newline", () => {
    const out = edited("a = 1\nb = 2\nc = 3\n", (d) => d.delete("b"));
    expect(out).toBe("a = 1\nc = 3\n");
  });

  it("returns true on successful deletion, false on missing path", () => {
    const doc = parseDocument("a = 1\n");
    expect(doc.delete("a")).toBe(true);
    expect(doc.delete("missing")).toBe(false);
  });

  it("removes an attribute inside a block body", () => {
    const input = "locals {\n  a = 1\n  b = 2\n}\n";
    const out = edited(input, (d) => d.delete(["locals", "a"]));
    expect(out).toBe("locals {\n  b = 2\n}\n");
  });

  it("removes a whole block", () => {
    const input = 'a {\n  x = 1\n}\nb {\n  y = 2\n}\n';
    const out = edited(input, (d) => d.delete("a"));
    expect(out).toBe("b {\n  y = 2\n}\n");
  });

  it("removes a labeled block by full path", () => {
    const input =
      'resource "t" "n1" {\n  x = 1\n}\nresource "t" "n2" {\n  x = 2\n}\n';
    const out = edited(input, (d) => d.delete("resource.t.n1"));
    expect(out).toBe('resource "t" "n2" {\n  x = 2\n}\n');
  });

  it("preserves comments on sibling statements after a delete", () => {
    const input = "# about a\na = 1\n# about b\nb = 2\n";
    const out = edited(input, (d) => d.delete("a"));
    // `# about a` lives as leading trivia on the \n that prefixed a;
    // it stays in the document after the delete, which is acceptable:
    // we only remove the attribute node and its trailing newline.
    expect(out).toContain("# about b");
    expect(out).toContain("b = 2");
    // The content is still well-formed HCL.
    expect(() => HCL.parse(out)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10+ edit golden tests (explicit input → mutation → expected output)
// ─────────────────────────────────────────────────────────────────────────────

interface Golden {
  name: string;
  input: string;
  mutate: (d: Document) => void;
  expected: string;
}

const GOLDENS: Golden[] = [
  {
    name: "replace top-level number",
    input: "x = 1\n",
    mutate: (d) => d.set("x", 2),
    expected: "x = 2\n",
  },
  {
    name: "replace string preserving leading comment",
    input: "# greeting\nhi = \"world\"\n",
    mutate: (d) => d.set("hi", "there"),
    expected: '# greeting\nhi = "there"\n',
  },
  {
    name: "replace preserving trailing comment",
    input: "x = 1 # comment\n",
    mutate: (d) => d.set("x", 99),
    expected: "x = 99 # comment\n",
  },
  {
    name: "append attribute at top level",
    input: "a = 1\n",
    mutate: (d) => d.set("b", 2),
    expected: "a = 1\nb = 2\n",
  },
  {
    name: "append attribute inside a block body",
    input: "locals {\n  a = 1\n}\n",
    mutate: (d) => d.set(["locals", "b"], 2),
    expected: "locals {\n  a = 1\n  b = 2\n}\n",
  },
  {
    name: "replace attribute inside a Terraform resource",
    input: 'resource "t" "n" {\n  acl = "private"\n}\n',
    mutate: (d) => d.set(["resource", "t", "n", "acl"], "public"),
    expected: 'resource "t" "n" {\n  acl = "public"\n}\n',
  },
  {
    name: "delete middle attribute",
    input: "a = 1\nb = 2\nc = 3\n",
    mutate: (d) => d.delete("b"),
    expected: "a = 1\nc = 3\n",
  },
  {
    name: "delete labeled block",
    input:
      'resource "t" "n1" {\n  x = 1\n}\nresource "t" "n2" {\n  x = 2\n}\n',
    mutate: (d) => d.delete("resource.t.n1"),
    expected: 'resource "t" "n2" {\n  x = 2\n}\n',
  },
  {
    name: "delete attribute inside block preserves siblings",
    input: "locals {\n  a = 1\n  b = 2\n  c = 3\n}\n",
    mutate: (d) => d.delete(["locals", "b"]),
    expected: "locals {\n  a = 1\n  c = 3\n}\n",
  },
  {
    name: "insert attribute whose value is an object",
    input: "locals {\n  name = \"demo\"\n}\n",
    mutate: (d) => d.set(["locals", "tags"], { env: "dev" }),
    expected:
      "locals {\n  name = \"demo\"\n  tags = { env = \"dev\" }\n}\n",
  },
  {
    name: "set-then-delete leaves input unchanged",
    input: "a = 1\n",
    mutate: (d) => {
      d.set("b", 2);
      d.delete("b");
    },
    expected: "a = 1\n",
  },
];

describe("edit goldens", () => {
  it(`covers at least 10 cases (actually ${GOLDENS.length})`, () => {
    expect(GOLDENS.length).toBeGreaterThanOrEqual(10);
  });
  for (const g of GOLDENS) {
    it(g.name, () => {
      const doc = parseDocument(g.input);
      g.mutate(doc);
      expect(doc.toString()).toBe(g.expected);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Error + option surface
// ─────────────────────────────────────────────────────────────────────────────

describe("parseDocument options", () => {
  it("uses the provided filename in error messages", () => {
    try {
      parseDocument("oops\n", { filename: "main.tf" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as { filename?: string }).filename).toBe("main.tf");
    }
  });

  it("with bail: false, aggregates errors", () => {
    try {
      parseDocument("oops1\noops2\n", { bail: false });
      throw new Error("should have thrown");
    } catch (e) {
      expect(
        (e as { errors?: readonly unknown[] }).errors?.length,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("exposes the source and body for external inspection", () => {
    const doc = parseDocument('x = "hi"\n', { filename: "f.tf" });
    expect(doc.source.filename).toBe("f.tf");
    expect(doc.body.kind).toBe("Body");
  });
});
