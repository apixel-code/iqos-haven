import { describe, expect, it } from "vitest";
import {
  EMPTY_LISTS,
  LIST_LIMITS,
  parseLists,
  recordView,
  removeFrom,
  renameIn,
  toggleCompare,
  toggleSaved,
  type DeviceLists,
} from "./lists";

const lists = (overrides: Partial<DeviceLists> = {}): DeviceLists => ({
  ...EMPTY_LISTS,
  ...overrides,
});

describe("device lists", () => {
  it("saves newest first and unsaves on the second press", () => {
    const one = toggleSaved(EMPTY_LISTS, "halo-7k");
    expect(one).toMatchObject({ saved: true, full: false });
    const two = toggleSaved(one.lists, "pod-kit-x");
    expect(two.lists.saved).toEqual(["pod-kit-x", "halo-7k"]);
    const off = toggleSaved(two.lists, "halo-7k");
    expect(off).toMatchObject({ saved: false, full: false });
    expect(off.lists.saved).toEqual(["pod-kit-x"]);
  });

  it("refuses a new saved item when the list is full, and says so", () => {
    const full = lists({
      saved: Array.from({ length: LIST_LIMITS.saved }, (_, index) => "p" + index),
    });
    const result = toggleSaved(full, "one-more");
    expect(result).toMatchObject({ saved: false, full: true });
    expect(result.lists).toBe(full);
    // Removing still works on a full list.
    expect(toggleSaved(full, "p0").lists.saved).toHaveLength(LIST_LIMITS.saved - 1);
  });

  it("compares at most three kits", () => {
    let current = EMPTY_LISTS;
    for (const slug of ["kit-a", "kit-b", "kit-c"]) current = toggleCompare(current, slug).lists;
    expect(current.compare).toEqual(["kit-a", "kit-b", "kit-c"]);
    expect(toggleCompare(current, "kit-d")).toMatchObject({ comparing: false, full: true });
    expect(toggleCompare(current, "kit-b").lists.compare).toEqual(["kit-a", "kit-c"]);
  });

  it("keeps recently viewed unique, newest first and bounded", () => {
    let current = EMPTY_LISTS;
    for (let index = 0; index < 20; index++) current = recordView(current, "p" + index);
    expect(current.recent).toHaveLength(LIST_LIMITS.recent);
    expect(current.recent[0]).toBe("p19");
    const again = recordView(current, "p12");
    expect(again.recent[0]).toBe("p12");
    expect(new Set(again.recent).size).toBe(again.recent.length);
    // Viewing the same product twice in a row changes nothing (no rewrite).
    expect(recordView(again, "p12")).toBe(again);
  });

  it("accepts only product slugs", () => {
    for (const bad of [
      "",
      "Has Space",
      "UPPER",
      "a".repeat(151),
      "../etc",
      "+971500000000",
      "a@b.c",
    ]) {
      expect(toggleSaved(EMPTY_LISTS, bad).lists).toBe(EMPTY_LISTS);
      expect(toggleCompare(EMPTY_LISTS, bad).lists).toBe(EMPTY_LISTS);
      expect(recordView(EMPTY_LISTS, bad)).toBe(EMPTY_LISTS);
    }
  });

  it("removes from one list only", () => {
    const current = lists({ saved: ["a", "b"], compare: ["a"], recent: ["a", "c"] });
    expect(removeFrom(current, "saved", "a")).toEqual(
      lists({ saved: ["b"], compare: ["a"], recent: ["a", "c"] }),
    );
    expect(removeFrom(current, "compare", "zzz")).toBe(current);
  });

  it("follows a rename everywhere without duplicates", () => {
    const current = lists({
      saved: ["old-halo", "new-halo", "b"],
      compare: ["old-halo"],
      recent: ["b", "old-halo"],
    });
    const next = renameIn(
      current,
      new Map([
        ["old-halo", "new-halo"],
        ["b", "b"],
      ]),
    );
    expect(next).toEqual(
      lists({ saved: ["new-halo", "b"], compare: ["new-halo"], recent: ["b", "new-halo"] }),
    );
    expect(renameIn(current, new Map([["b", "b"]]))).toBe(current);
    // A rename target that is not a slug is ignored.
    expect(renameIn(current, new Map([["b", "Not A Slug"]]))).toBe(current);
  });

  it("stores slugs only, and reads anything else as empty", () => {
    const stored = JSON.stringify(lists({ saved: ["halo-7k"], recent: ["halo-7k", "pod-kit-x"] }));
    expect(parseLists(stored).saved).toEqual(["halo-7k"]);
    expect(Object.keys(JSON.parse(stored)).sort()).toEqual(["compare", "recent", "saved", "v"]);
    for (const bad of [
      null,
      "",
      "nope",
      "[]",
      '{"v":2,"saved":[],"compare":[],"recent":[]}',
      JSON.stringify({ ...lists(), saved: ["Not A Slug"] }),
      JSON.stringify({ ...lists(), compare: ["a", "b", "c", "d"] }),
      // Anything about the shopper invalidates the value instead of being carried along.
      JSON.stringify({ ...lists(), phone: "+971500000000" }),
      JSON.stringify({ ...lists(), saved: [{ slug: "a", name: "Aisha" }] }),
    ])
      expect(parseLists(bad), String(bad)).toEqual(EMPTY_LISTS);
    expect(parseLists(JSON.stringify(lists({ saved: ["a", "a", "b"] }))).saved).toEqual(["a", "b"]);
  });
});
