import { describe, expect, it } from "vitest";
import { guideCreateRequestSchema, guidePlainText, readGuideBody } from "./guides";

const valid = {
  slug: "terea-japan-guide",
  title: "TEREA Japan: every flavour",
  summary: "What each TEREA Japan flavour tastes like.",
  body: "Intro text.",
  published: false,
};

describe("guide body (ADR 0117)", () => {
  it("reads headings, paragraphs, lists, bold and store links", () => {
    const { blocks, problems } = readGuideBody(
      [
        "## Menthol flavours",
        "TEREA **Black Menthol** is the strongest.\nSee [all sticks](/sticks).",
        "- Menthol\n- Black Menthol",
        "1. Pick a device\n2. Pick a flavour",
        "### Delivery",
        "[Help](/help#help-delivery)",
      ].join("\n\n"),
    );
    expect(problems).toEqual([]);
    expect(blocks).toEqual([
      { kind: "h2", text: "Menthol flavours" },
      {
        kind: "p",
        inline: [
          { kind: "text", text: "TEREA " },
          { kind: "strong", text: "Black Menthol" },
          { kind: "text", text: " is the strongest. See " },
          { kind: "link", text: "all sticks", href: "/sticks" },
          { kind: "text", text: "." },
        ],
      },
      {
        kind: "ul",
        items: [[{ kind: "text", text: "Menthol" }], [{ kind: "text", text: "Black Menthol" }]],
      },
      {
        kind: "ol",
        items: [
          [{ kind: "text", text: "Pick a device" }],
          [{ kind: "text", text: "Pick a flavour" }],
        ],
      },
      { kind: "h3", text: "Delivery" },
      { kind: "p", inline: [{ kind: "link", text: "Help", href: "/help#help-delivery" }] },
    ]);
    expect(guidePlainText(blocks)).toContain("TEREA Black Menthol is the strongest.");
  });

  it("refuses links that leave the store", () => {
    for (const href of [
      "https://example.com",
      "//example.com",
      "javascript:alert(1)",
      "/Sticks",
      "/sticks?x=1",
      "mailto:a@b.c",
      "",
    ])
      expect(readGuideBody(`See [this](${href}).`).problems, href).toHaveLength(1);
  });

  it("validates the whole guide: plain text, bounded, store links only", () => {
    expect(guideCreateRequestSchema.safeParse(valid).success).toBe(true);
    for (const bad of [
      { ...valid, body: "" },
      { ...valid, body: "<script>x</script>" },
      { ...valid, body: "Go [here](https://example.com)." },
      { ...valid, body: "a".repeat(30_001) },
      { ...valid, title: "Line‮flip" },
      { ...valid, summary: "" },
      { ...valid, slug: "Not A Slug" },
      { ...valid, extra: true },
    ])
      expect(
        guideCreateRequestSchema.safeParse(bad).success,
        JSON.stringify(bad).slice(0, 60),
      ).toBe(false);
    // Newlines are the body's structure and are kept; titles are one line.
    const parsed = guideCreateRequestSchema.parse({
      ...valid,
      title: "  Two\nlines ",
      body: "One\r\n\r\nTwo",
    });
    expect(parsed.title).toBe("Two lines");
    expect(parsed.body).toBe("One\n\nTwo");
  });
});
