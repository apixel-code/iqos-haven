import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service";
import { OutboxService } from "./outbox.service";

/** Reliability writers used inside mutations. No controllers: never editable over HTTP. */
@Global()
@Module({ providers: [AuditService, OutboxService], exports: [AuditService, OutboxService] })
export class ReliabilityModule {}
