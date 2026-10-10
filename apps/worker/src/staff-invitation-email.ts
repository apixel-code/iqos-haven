import { PermanentEffectError, staffInvitationTemplate, type EmailPlanner } from "@ih/application";
import { EVENT_CATALOGUE } from "@ih/contracts";
import type { WorkerEnv } from "@ih/config";
import { loadStaffInvitationEmail, sameResetHash, type Database } from "@ih/db";
import { invitationToken, invitationTokenHash } from "@ih/platform";
export function staffInvitationEmailPlanner(db: Database, env: WorkerEnv): EmailPlanner {
  return async (context) => {
    const payload = EVENT_CATALOGUE["staff.invited"].payload.safeParse(context.payload);
    if (!payload.success || context.schemaVersion !== 1)
      throw new PermanentEffectError("INVALID_INVITATION_EVENT");
    const invite = await loadStaffInvitationEmail(db, payload.data.invitationId);
    if (!invite) return null;
    if (context.aggregateId !== invite.id)
      throw new PermanentEffectError("INVALID_INVITATION_EVENT");
    const key = env.STAFF_INVITATION_KEYS.find((key) => key.keyId === invite.keyId);
    if (!key || !env.STAFF_INVITATION_ORIGIN) throw new Error("INVITATION_CONFIGURATION_MISSING");
    const token = invitationToken(invite.id, key);
    if (!sameResetHash(invite.tokenHash, invitationTokenHash(token))) return null;
    return {
      template: staffInvitationTemplate,
      data: { inviteUrl: `${env.STAFF_INVITATION_ORIGIN}/invite/accept#token=${token}` },
      recipients: [invite.email],
    };
  };
}
