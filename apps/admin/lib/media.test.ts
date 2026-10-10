import { describe, expect, it } from "vitest";
import { FormValidationError } from "./management";
import { moved, rejectionMessage, uploadForm, uploadRequestFor } from "./media";

describe("image upload helpers", () => {
  it("pre-checks type and size before asking for an upload", () => {
    expect(uploadRequestFor({ type: "image/png", size: 1000 })).toEqual({
      contentType: "image/png",
      bytes: 1000,
    });
    for (const file of [
      { type: "image/svg+xml", size: 10 },
      { type: "image/gif", size: 10 },
      { type: "image/jpeg", size: 0 },
      { type: "image/jpeg", size: 8 * 1024 * 1024 + 1 },
    ])
      expect(() => uploadRequestFor(file)).toThrow(FormValidationError);
  });

  it("puts the policy fields before the file", () => {
    const form = uploadForm({ key: "uploads/x", Policy: "p" }, new Blob(["x"]));
    expect([...form.keys()]).toEqual(["key", "Policy", "file"]);
  });

  it("explains rejections and reorders", () => {
    expect(rejectionMessage("animated")).toContain("Animated");
    expect(rejectionMessage("unknown_code")).toContain("could not be processed");
    expect(moved(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    expect(moved(["a", "b"], "a", -1)).toEqual(["a", "b"]);
  });
});
