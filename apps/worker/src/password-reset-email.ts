import { PermanentEffectError, passwordResetTemplate, type EmailPlanner } from "@ih/application";
import { EVENT_CATALOGUE } from "@ih/contracts";
import type { WorkerEnv } from "@ih/config";
import { loadPasswordResetEmail, sameResetHash, type Database } from "@ih/db";
import { resetToken, resetTokenHash, resetRecipientHash } from "@ih/platform";

export function passwordResetEmailPlanner(db: Database, env: WorkerEnv): EmailPlanner {
  return async (context) => {
    const payload = EVENT_CATALOGUE["staff.password_reset_requested"].payload.safeParse(
      context.payload,
    );
    if (!payload.success || context.schemaVersion !== 1)
      throw new PermanentEffectError("INVALID_RESET_EVENT");
    const reset = await loadPasswordResetEmail(db, payload.data.resetId);
    if (!reset) return null;
    if (context.aggregateId !== reset.userId) throw new PermanentEffectError("INVALID_RESET_EVENT");
    const key = env.PASSWORD_RESET_KEYS.find((key) => key.keyId === reset.keyId);
    // Configuration faults retry; retain old keys through delivery/expiry when rotating.
    if (!key || !env.PASSWORD_RESET_ORIGIN) throw new Error("RESET_CONFIGURATION_MISSING");
    const token = resetToken(reset.id, key);
    if (
      !sameResetHash(reset.tokenHash, resetTokenHash(token)) ||
      !sameResetHash(reset.recipientHash, resetRecipientHash(reset.user.email, key))
    )
      return null;
    // Fragment keeps the token out of HTTP URLs, proxy logs and referrers. UI consumes it in step 37.
    const resetUrl = `${env.PASSWORD_RESET_ORIGIN}/reset#token=${token}`;
    return { template: passwordResetTemplate, data: { resetUrl }, recipients: [reset.user.email] };
  };
}
