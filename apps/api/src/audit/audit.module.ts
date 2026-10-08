import { Global, Module } from "@nestjs/common";
import { AuditService } from "./audit.service";

/** No controllers: audit is never editable or deletable over HTTP. */
@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
