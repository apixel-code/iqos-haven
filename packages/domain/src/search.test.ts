import { describe, expect, it } from "vitest";
import { normalizeSearchTerm, prefixTsQuery, SEARCH_LIMITS } from "./search";

describe("search term normalization", () => {
  it("lower-cases, splits on anything that is not a letter or digit, and joins with one space", () => {
    expect(normalizeSearchTerm("  Orbe   HALO-7K  ")).toEqual({
      text: "orbe halo 7k",
      tokens: ["orbe", "halo", "7k"],
    });
    expect(normalizeSearchTerm("Grape/Ice (20mg)").tokens).toEqual(["grape", "ice", "20mg"]);
    expect(normalizeSearchTerm("ＯＲＢＥ").text).toBe("orbe");
    expect(normalizeSearchTerm("فيب عنب").tokens).toEqual(["فيب", "عنب"]);
  });

  it("returns nothing searchable for empty, punctuation-only and missing input", () => {
    for (const input of ["", "   ", "!!!", "&|:*'\"()", null, undefined])
      expect(normalizeSearchTerm(input)).toEqual({ text: "", tokens: [] });
  });

  it("removes query operators, quotes, wildcards and control characters", () => {
    const term = normalizeSearchTerm("mint' | !ice:* & (a) \\ % _ \u0000 ; DROP");
    expect(term.tokens).toEqual(["mint", "ice", "a", "drop"]);
    expect(term.text).toMatch(/^[\p{L}\p{N} ]*$/u);
    expect(prefixTsQuery(term)).toBe("'mint':* & 'ice':* & 'a':* & 'drop':*");
  });

  it("bounds the number and length of tokens and the total length", () => {
    const many = normalizeSearchTerm("a b c d e f g h i j");
    expect(many.tokens).toHaveLength(SEARCH_LIMITS.maxTokens);
    const long = normalizeSearchTerm("x".repeat(500));
    expect(long.tokens).toEqual(["x".repeat(SEARCH_LIMITS.maxTokenLength)]);
    const wide = normalizeSearchTerm(Array.from({ length: 6 }, () => "w".repeat(30)).join(" "));
    expect(wide.text.length).toBeLessThanOrEqual(SEARCH_LIMITS.maxLength);
    expect(wide.tokens).toHaveLength(2);
    expect(normalizeSearchTerm("y".repeat(100_000)).text.length).toBeLessThanOrEqual(64);
  });

  it("builds an empty query for an empty term", () => {
    expect(prefixTsQuery(normalizeSearchTerm(""))).toBe("");
  });
});
