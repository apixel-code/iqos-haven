import { describe, expect, it } from "vitest";
import { Argon2PasswordHasher } from "./argon2";

// Minimum allowed cost keeps the test fast; production values come from config.
const hasher = new Argon2PasswordHasher({ memoryKib: 19_456, timeCost: 2, parallelism: 1 });

describe("Argon2PasswordHasher", () => {
  it("produces salted argon2id PHC hashes that verify", async () => {
    const first = await hasher.hash("copper-lantern-river-71");
    const second = await hasher.hash("copper-lantern-river-71");
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(first).not.toBe(second); // random salt
    expect(await hasher.verify(first, "copper-lantern-river-71")).toBe(true);
    expect(await hasher.verify(first, "copper-lantern-river-72")).toBe(false);
  });

  it("rejects malformed or foreign hashes without throwing", async () => {
    expect(await hasher.verify("plaintext", "x")).toBe(false);
    expect(await hasher.verify("$2b$12$abcdefghijklmnopqrstuv", "x")).toBe(false);
  });

  it("asks for a rehash when parameters change", async () => {
    const stored = await hasher.hash("copper-lantern-river-71");
    expect(hasher.needsRehash(stored)).toBe(false);
    const stronger = new Argon2PasswordHasher({ memoryKib: 65_536, timeCost: 3, parallelism: 1 });
    expect(stronger.needsRehash(stored)).toBe(true);
    expect(await stronger.verify(stored, "copper-lantern-river-71")).toBe(true);
  });
});
