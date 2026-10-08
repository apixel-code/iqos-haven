import { Injectable } from "@nestjs/common";
import { toAuditEntry, type AuditRecord, type CommandContext } from "@ih/application";
import { PrismaAuditWriter, type Tx } from "@ih/db";

/**
 * Records audit entries inside the caller's unit of work (`withTransaction`).
 * Write-only by design: audit reads arrive later behind RBAC; there is no edit or delete path.
 */
@Injectable()
export class AuditService {
  private readonly writer = new PrismaAuditWriter();

  async record(tx: Tx, context: CommandContext, record: AuditRecord): Promise<void> {
    await this.writer.append(tx, toAuditEntry(context, record));
  }
}
