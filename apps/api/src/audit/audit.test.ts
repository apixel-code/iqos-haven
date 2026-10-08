import "reflect-metadata";
import { MODULE_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { AuditModule } from "./audit.module";
import { AuditService } from "./audit.service";

describe("AuditModule", () => {
  it("exposes no HTTP controllers", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AuditModule) ?? []).toEqual([]);
    expect(Reflect.getMetadata(METHOD_METADATA, AuditService.prototype.record)).toBeUndefined();
  });

  it("refuses to write outside a unit of work before touching the database", async () => {
    const service = new AuditService();
    await expect(
      service.record(
        {} as never,
        { requestId: "r1", actorId: null },
        {
          action: "settings.updated",
          entity: { type: "settings", id: "store" },
          after: { lowStockThreshold: 5 },
        },
      ),
    ).rejects.toMatchObject({ code: "AUDIT_OUTSIDE_TRANSACTION" });
  });

  it("rejects an invalid audit action before persistence", async () => {
    const service = new AuditService();
    await expect(
      service.record(
        {} as never,
        { requestId: "r1", actorId: null },
        {
          action: "Delete Everything",
          entity: { type: "settings", id: "store" },
        },
      ),
    ).rejects.toThrow(RangeError);
  });
});
