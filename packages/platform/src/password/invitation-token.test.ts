import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { invitationToken, invitationTokenHash, invitationTokenId } from "./invitation-token";
import { resetToken } from "./reset-token";
it("reproduces invitation secrets while separating reset and invitation purposes", () => {
  const key = { keyId: "one", secret: Buffer.alloc(32, 2).toString("base64url") };
  const id = randomUUID();
  const token = invitationToken(id, key);
  expect(invitationTokenId(token)).toBe(id);
  expect(invitationTokenHash(token)).toHaveLength(32);
  expect(invitationToken(id, key)).toBe(token);
  expect(token).not.toBe(resetToken(id, key));
  expect(invitationToken(randomUUID(), key)).not.toBe(token);
  expect(invitationTokenId("junk")).toBeNull();
});
