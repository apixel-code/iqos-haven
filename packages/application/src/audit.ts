import { assertAuditEntry, buildAuditDiff, type AuditActor, type AuditEntry } from "@ih/domain";
import type { CommandContext } from "./index";

/** What a use case reports; actor/request/command come from the CommandContext. */
export interface AuditRecord {
  readonly action: string;
  readonly entity: { readonly type: string; readonly id: string };
  readonly before?: Readonly<Record<string, unknown>> | null;
  readonly after?: Readonly<Record<string, unknown>> | null;
  readonly reason?: string;
  /** Extra entity-specific fields to redact. Personal fields are already redacted by default. */
  readonly redact?: readonly string[];
  /** Personal-looking fields that are not personal for this entity (e.g. product `name`). */
  readonly reveal?: readonly string[];
}

/**
 * Port implemented by the persistence layer. `tx` is the caller's open unit of work:
 * audit rows commit or roll back together with the mutation they describe.
 */
export interface AuditWriter<TTx> {
  append(tx: TTx, entry: AuditEntry): Promise<void>;
}

export function toAuditEntry(context: CommandContext, record: AuditRecord): AuditEntry {
  const actor: AuditActor =
    context.actorId === null ? { type: "system" } : { type: "staff", id: context.actorId };
  return assertAuditEntry({
    actor,
    action: record.action,
    entityType: record.entity.type,
    entityId: record.entity.id,
    requestId: context.requestId,
    ...(context.commandId === undefined ? {} : { commandId: context.commandId }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    diff: buildAuditDiff(record.before ?? null, record.after ?? null, {
      ...(record.redact ? { redact: record.redact } : {}),
      ...(record.reveal ? { reveal: record.reveal } : {}),
    }),
  });
}
