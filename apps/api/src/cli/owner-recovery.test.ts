import { describe, expect, it } from "vitest";
import { runOwnerRecovery, type RecoveryDeps } from "./owner-recovery";

const GOOD = "copper-lantern-river-71";
const ARGS = ["--email", "Owner@IqosHaven.com", "--reason", "INC-7 sole Owner locked out"];

function deps(overrides: Partial<RecoveryDeps> & { passwords?: string[] } = {}) {
  const output: string[] = [];
  const calls: Array<Parameters<RecoveryDeps["recover"]>[0]> = [];
  const passwords = [...(overrides.passwords ?? [GOOD, GOOD])];
  const base: RecoveryDeps = {
    argv: ARGS,
    interactive: true,
    readPassword: async () => passwords.shift() ?? "",
    hash: async (password) => `$argon2id$v=19$m=65536,t=3,p=1$salt$${password.length}`,
    recover: async (input) => {
      calls.push(input);
      return { id: "owner-id", reactivated: true, sessionsRevoked: 2, otherActiveOwners: 0 };
    },
    out: (line) => output.push(line),
  };
  return { deps: { ...base, ...overrides }, output, calls };
}

describe("ops:owner-recovery CLI (step 127)", () => {
  it("recovers with a hashed password and the incident reason, never echoing the password", async () => {
    const { deps: d, output, calls } = deps();
    expect(await runOwnerRecovery(d)).toBe(0);
    expect(calls).toEqual([
      {
        email: "owner@iqoshaven.com",
        passwordHash: expect.stringMatching(/^\$argon2id\$/),
        reason: "INC-7 sole Owner locked out",
        despiteActiveOwner: false,
      },
    ]);
    expect(output.join("\n")).toContain("2 session(s) signed out");
    expect(output.join("\n")).not.toContain(GOOD);
  });

  it("requires a reason and rejects a password argument or a weak password", async () => {
    for (const argv of [
      ["--email", "o@iqoshaven.com"],
      [...ARGS, "--password", GOOD],
    ]) {
      const { deps: d, calls } = deps({ argv });
      expect(await runOwnerRecovery(d)).toBe(2);
      expect(calls).toEqual([]);
    }
    const weak = deps({ passwords: ["short", "short"] });
    expect(await runOwnerRecovery(weak.deps)).toBe(2);
    expect(weak.calls).toEqual([]);
    const mismatch = deps({ passwords: [GOOD, GOOD + "x"] });
    expect(await runOwnerRecovery(mismatch.deps)).toBe(2);
  });

  it("explains a refusal without changing anything", async () => {
    const { deps: d, output } = deps({
      recover: async () => {
        throw Object.assign(new Error("x"), { code: "OWNER_RECOVERY_ACTIVE_OWNER" });
      },
    });
    expect(await runOwnerRecovery(d)).toBe(3);
    expect(output.join("\n")).toContain("--despite-active-owner");
  });
});
