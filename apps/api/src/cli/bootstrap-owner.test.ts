import { describe, expect, it } from "vitest";
import { runBootstrap, type BootstrapDeps } from "./bootstrap-owner";

const GOOD = "copper-lantern-river-71";

function deps(overrides: Partial<BootstrapDeps> & { passwords?: string[] } = {}) {
  const output: string[] = [];
  const created: Array<{ email: string; name: string; passwordHash: string }> = [];
  const passwords = [...(overrides.passwords ?? [GOOD, GOOD])];
  const base: BootstrapDeps = {
    argv: ["--email", "Owner@IqosHaven.com", "--name", "Aisha Rahman"],
    interactive: true,
    readPassword: async () => passwords.shift() ?? "",
    ownerExists: async () => false,
    hash: async (password) => `$argon2id$v=19$m=65536,t=3,p=1$salt$${password.length}`,
    bootstrap: async (input) => {
      created.push(input);
      return "0199c4a2-7b1e-7c3a-9f00-1234567890ab";
    },
    out: (line) => output.push(line),
  };
  return { deps: { ...base, ...overrides }, output, created };
}

describe("bootstrap:owner CLI", () => {
  it("creates the Owner from operator input with a hashed password", async () => {
    const { deps: d, output, created } = deps();
    expect(await runBootstrap(d)).toBe(0);
    expect(created).toEqual([
      {
        email: "owner@iqoshaven.com",
        name: "Aisha Rahman",
        passwordHash: expect.stringMatching(/^\$argon2id\$/),
      },
    ]);
    expect(output.join("\n")).toContain("Owner created: owner@iqoshaven.com");
    expect(output.join("\n")).not.toContain(GOOD);
  });

  it("refuses a password given as an argument", async () => {
    const { deps: d, created } = deps({
      argv: ["--email", "o@x.ae", "--name", "A B", "--password", GOOD],
    });
    expect(await runBootstrap(d)).toBe(2);
    expect(created).toEqual([]);
  });

  it.each([
    ["mismatched confirmation", [GOOD, GOOD + "x"]],
    ["weak password", ["Password1234!", "Password1234!"]],
    ["password containing the name", ["aisha-garden-river", "aisha-garden-river"]],
  ])("creates nothing on a %s", async (_name, passwords) => {
    const { deps: d, output, created } = deps({ passwords });
    expect(await runBootstrap(d)).toBe(2);
    expect(created).toEqual([]);
    expect(output.join("\n")).not.toContain(passwords[0]!);
  });

  it("needs a terminal unless --password-stdin is given, and then asks once", async () => {
    const noTty = deps({ interactive: false });
    expect(await runBootstrap(noTty.deps)).toBe(2);
    let prompts = 0;
    const piped = deps({
      interactive: false,
      argv: ["--email", "o@x.ae", "--name", "Aisha Rahman", "--password-stdin"],
      readPassword: async () => {
        prompts++;
        return GOOD;
      },
    });
    expect(await runBootstrap(piped.deps)).toBe(0);
    expect(prompts).toBe(1);
  });

  it("reports an existing Owner without creating anything", async () => {
    const { deps: d, output } = deps({
      bootstrap: async () =>
        Promise.reject(Object.assign(new Error("x"), { code: "OWNER_ALREADY_EXISTS" })),
    });
    expect(await runBootstrap(d)).toBe(3);
    expect(output.join("\n")).toContain("already exists");
  });

  it("validates email and name before asking for a password", async () => {
    let asked = false;
    const { deps: d } = deps({
      argv: ["--email", "not-an-email", "--name", "A B"],
      readPassword: async () => {
        asked = true;
        return GOOD;
      },
    });
    expect(await runBootstrap(d)).toBe(2);
    expect(asked).toBe(false);
  });

  it("refuses before asking for a password when an Owner already exists", async () => {
    let asked = false;
    const {
      deps: d,
      output,
      created,
    } = deps({
      ownerExists: async () => true,
      readPassword: async () => {
        asked = true;
        return GOOD;
      },
    });
    expect(await runBootstrap(d)).toBe(3);
    expect(asked).toBe(false);
    expect(created).toEqual([]);
    expect(output.join("\n")).toContain("already exists");
  });

  it("treats an aborted prompt as nothing created", async () => {
    const { deps: d, created } = deps({
      readPassword: async () => Promise.reject(new Error("Aborted")),
    });
    expect(await runBootstrap(d)).toBe(2);
    expect(created).toEqual([]);
  });

  it("hashes the NFKC-normalized password", async () => {
    const hashed: string[] = [];
    const composed = "copper-lantern-\u00e9clair-71";
    const decomposed = "copper-lantern-e\u0301clair-71";
    const { deps: d } = deps({
      passwords: [decomposed, composed],
      hash: async (password) => {
        hashed.push(password);
        return "$argon2id$v=19$m=65536,t=3,p=1$salt$x";
      },
    });
    expect(await runBootstrap(d)).toBe(0);
    expect(hashed).toEqual([composed]);
  });
});
