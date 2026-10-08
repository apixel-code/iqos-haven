import type { AuditWriter } from "@ih/application";
import { assertAuditEntry, type AuditEntry } from "@ih/domain";
import type { Tx } from "./client";
import { isUnitOfWork } from "./transaction";

export class AuditOutsideTransactionError extends Error {
  readonly code = "AUDIT_OUTSIDE_TRANSACTION";
}

/**
 * Appends to `audit_log` inside the caller's transaction. There is deliberately no update or
 * delete method; the table additionally rejects both by trigger and runtime-role grants.
 */
export class PrismaAuditWriter implements AuditWriter<Tx> {
  async append(tx: Tx, entry: AuditEntry): Promise<void> {
    // A root client would commit the audit row independently of the mutation it describes.
    if (!isUnitOfWork(tx))
      throw new AuditOutsideTransactionError("Audit must be written inside withTransaction()");
    const valid = assertAuditEntry(entry);
    await tx.auditLog.create({
      data: {
        actorType: valid.actor.type,
        actorId: valid.actor.type === "staff" ? valid.actor.id : null,
        action: valid.action,
        entityType: valid.entityType,
        entityId: valid.entityId,
        requestId: valid.requestId,
        commandId: valid.commandId ?? null,
        reason: valid.reason ?? null,
        diff: valid.diff,
      },
    });
  }
}
