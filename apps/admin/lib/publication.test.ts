import { describe, expect, it } from "vitest";
import { PUBLISH_REQUIREMENTS } from "@ih/contracts";
import { requirementLabel } from "./publication";

describe("publish requirement copy", () => {
  it("explains every server requirement", () => {
    for (const requirement of PUBLISH_REQUIREMENTS)
      expect(requirementLabel(requirement)).toBeTruthy();
    expect(requirementLabel("tax_treatment")).toContain("accountant");
  });
});
