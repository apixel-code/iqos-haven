import { describe, expect, it } from "vitest";
import {
  declareUnsaved,
  declaredUnsaved,
  leavesView,
  snapshotFields,
  unsavedMessage,
} from "./unsaved";

const field = (name: string, value: string, type = "text", checked = false) => ({
  name,
  type,
  value,
  checked,
});

describe("unsaved-changes guard", () => {
  it("snapshots values and checks, ignoring buttons and file pickers", () => {
    const base = snapshotFields([field("name", "Halo"), field("isNew", "on", "checkbox")]);
    expect(snapshotFields([field("name", "Halo"), field("isNew", "on", "checkbox")])).toBe(base);
    expect(snapshotFields([field("name", "Halo 2"), field("isNew", "on", "checkbox")])).not.toBe(
      base,
    );
    expect(
      snapshotFields([field("name", "Halo"), field("isNew", "on", "checkbox", true)]),
    ).not.toBe(base);
    expect(
      snapshotFields([
        field("name", "Halo"),
        field("", "Save", "submit"),
        field("photo", "C:\\fakepath\\a.png", "file"),
        field("isNew", "on", "checkbox"),
      ]),
    ).toBe(base);
    // An added row (e.g. a new option) is a change.
    expect(
      snapshotFields([field("name", "Halo"), field("isNew", "on", "checkbox"), field("x", "")]),
    ).not.toBe(base);
  });

  it("treats only plain same-tab clicks to another admin view as leaving", () => {
    const here = "http://localhost:8081/workspace/products?product=1";
    const link = (href: string, target = "", download = false) => ({ href, target, download });
    const plain = { button: 0, modified: false };
    expect(leavesView(link("/workspace/orders"), plain, here)).toBe(true);
    expect(leavesView(link("/workspace/products"), plain, here)).toBe(true);
    expect(leavesView(link("/workspace/products?product=1#images"), plain, here)).toBe(false);
    expect(leavesView(link("https://wa.me/971500000000"), plain, here)).toBe(false);
    expect(leavesView(link("/workspace/orders", "_blank"), plain, here)).toBe(false);
    expect(leavesView(link("/report.csv", "", true), plain, here)).toBe(false);
    expect(leavesView(link("/workspace/orders"), { button: 0, modified: true }, here)).toBe(false);
    expect(leavesView(link("/workspace/orders"), { button: 1, modified: false }, here)).toBe(false);
  });

  it("keeps declared unsaved state until it is cleared", () => {
    const owner = Symbol("test");
    expect(declaredUnsaved()).toBeNull();
    declareUnsaved(owner, "the storefront content");
    expect(declaredUnsaved()).toBe("the storefront content");
    declareUnsaved(owner, null);
    expect(declaredUnsaved()).toBeNull();
    expect(unsavedMessage("Halo")).toBe(
      "You have unsaved changes to Halo. If you leave now, they will be lost.",
    );
  });
});
