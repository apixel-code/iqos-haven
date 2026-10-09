import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizeStaffName, passwordProblems } from "./identity";

describe("staff identity rules", () => {
  it("normalizes emails and rejects malformed ones", () => {
    expect(normalizeEmail("  Owner@IqosHaven.COM ")).toBe("owner@iqoshaven.com");
    for (const bad of ["", "owner", "owner@", "a b@x.ae", "x".repeat(250) + "@x.ae"])
      expect(() => normalizeEmail(bad)).toThrow("INVALID_EMAIL");
  });

  it("normalizes names", () => {
    expect(normalizeStaffName("  Aisha   Rahman ")).toBe("Aisha Rahman");
    expect(() => normalizeStaffName("   ")).toThrow("INVALID_NAME");
  });

  it("accepts a long, unrelated passphrase", () => {
    expect(
      passwordProblems("copper-lantern-river-71", { email: "owner@x.ae", name: "Aisha Rahman" }),
    ).toEqual([]);
  });

  it.each([
    ["short", "Short1!", ["TOO_SHORT"]],
    ["too long", "a1b2c3d4".repeat(17), ["TOO_LONG"]],
    ["common", "MyPassword2026!", ["TOO_COMMON"]],
    ["brand", "IqosHaven-2026-x", ["TOO_COMMON"]],
    ["repetitive", "aaaaaaaaaaaaaaaa", ["TOO_REPETITIVE"]],
  ])("rejects a %s password", (_name, password, expected) => {
    expect(passwordProblems(password)).toEqual(expected);
  });

  it("rejects passwords containing the email local part or a name", () => {
    expect(passwordProblems("aisha-spring-garden", { email: "aisha@x.ae" })).toContain(
      "CONTAINS_IDENTITY",
    );
    expect(passwordProblems("blue-rahman-mountain", { name: "Aisha Rahman" })).toContain(
      "CONTAINS_IDENTITY",
    );
  });
});
