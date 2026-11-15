import { describe, expect, it } from "vitest";
import { srcSetOf } from "./image";

const urls = { thumb: "t.webp", medium: "m.webp", large: "l.webp" };

describe("srcSetOf", () => {
  it("gives each derivative its real width from the longest-side rule", () => {
    expect(srcSetOf({ width: 3584, height: 1184, urls })).toBe(
      "t.webp 320w, m.webp 800w, l.webp 1600w",
    );
    // Portrait: the height is the longest side, so widths are smaller.
    expect(srcSetOf({ width: 1000, height: 2000, urls })).toBe(
      "t.webp 160w, m.webp 400w, l.webp 800w",
    );
  });
  it("lists a small original once per distinct width (never enlarged)", () => {
    expect(srcSetOf({ width: 600, height: 400, urls })).toBe("t.webp 320w, m.webp 600w");
  });
});
