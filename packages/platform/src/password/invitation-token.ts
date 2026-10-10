import { createHmac } from "node:crypto";
import { resetTokenHash, resetTokenId, type ResetKey } from "./reset-token";
/** Independent key and purpose: a reset token can never authorize invitation acceptance. */
export function invitationToken(id: string, key: ResetKey): string {
  return `${id}.${createHmac("sha256", Buffer.from(key.secret, "base64url")).update(`ih:staff-invitation:v1:${id}`).digest("base64url")}`;
}
export const invitationTokenHash = resetTokenHash;
export const invitationTokenId = resetTokenId;
