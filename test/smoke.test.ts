import { describe, it, expect } from "vitest";
import HCL, {
  parse,
  parseDocument,
  stringify,
} from "../src/index.js";

describe("public API surface", () => {
  it("exports parse, stringify, parseDocument from the default export", () => {
    expect(HCL.parse).toBe(parse);
    expect(HCL.stringify).toBe(stringify);
    expect(HCL.parseDocument).toBe(parseDocument);
  });

  it("HCL.parse is live as of M5", () => {
    expect(parse("x = 1\n")).toEqual({ x: 1 });
  });

  it("HCL.stringify is live as of M6", () => {
    expect(stringify({ x: 1 })).toBe("x = 1\n");
  });

  it("HCL.parseDocument is live as of M7", () => {
    const doc = parseDocument("x = 1\n");
    expect(doc.toString()).toBe("x = 1\n");
    expect(doc.toValue()).toEqual({ x: 1 });
  });
});
