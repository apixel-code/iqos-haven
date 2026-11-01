import { describe, expect, it } from "vitest";
import { contentTypeFor, restorableEntries } from "./restore-media";

const file = (n: string) => `media/${n.repeat(64)}.enc`;

describe("media restore (server moves and real restores)", () => {
  it("restores derivatives with their content type", () => {
    expect(contentTypeFor("products/p1/a1/thumb.webp")).toBe("image/webp");
    expect(contentTypeFor("content/a1/large.JPG")).toBe("image/jpeg");
    expect(contentTypeFor("content/a1/blob")).toBe("application/octet-stream");
  });

  it("keeps only valid keys and sealed files, each key once", () => {
    const entries = restorableEntries([
      { key: "products/p1/a1/thumb.webp", file: file("a"), size: 1, sha256: "x" },
      { key: "products/p1/a1/thumb.webp", file: file("b"), size: 1, sha256: "x" },
      { key: "../etc/passwd", file: file("c"), size: 1, sha256: "x" },
      { key: "content/a2/large.webp", file: "../../secret", size: 1, sha256: "x" },
    ]);
    expect(entries.map((entry) => entry.key)).toEqual(["products/p1/a1/thumb.webp"]);
  });
});
