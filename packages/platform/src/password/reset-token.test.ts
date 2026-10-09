import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resetToken, resetTokenHash, resetTokenId, resetRecipientHash } from "./reset-token";
it("reproduces a purpose-bound 256-bit secret for delivery without persisting it", () => {
  const id = randomUUID();
  const key = { keyId: "one", secret: Buffer.alloc(32, 3).toString("base64url") };
  const token = resetToken(id, key);
  expect(resetTokenId(token)).toBe(id);
  expect(resetToken(token.split(".")[0]!, key)).toBe(token);
  expect(Buffer.from(token.split(".")[1]!, "base64url")).toHaveLength(32);
  expect(resetTokenHash(token)).toHaveLength(32);
  expect(resetToken(randomUUID(), key)).not.toBe(token);
  expect(resetToken(id, { ...key, secret: Buffer.alloc(32, 4).toString("base64url") })).not.toBe(
    token,
  );
  expect(resetRecipientHash("a@x.test", key)).not.toEqual(resetTokenHash(token));
  expect(resetRecipientHash("a@x.test", key)).not.toEqual(resetRecipientHash("b@x.test", key));
});
describe("reset selector parsing", () => {
  it.each(["", "junk", `${randomUUID()}.short`, `../x.${"A".repeat(43)}`])("refuses %s", (token) =>
    expect(resetTokenId(token)).toBeNull(),
  );
});
