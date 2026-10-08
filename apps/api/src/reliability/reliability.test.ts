import "reflect-metadata";
import { MODULE_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { describe, expect, it } from "vitest";
import { defineEvent } from "@ih/contracts";
import { AuditService } from "./audit.service";
import { OutboxService } from "./outbox.service";
import { ReliabilityModule } from "./reliability.module";

describe("ReliabilityModule", () => {
  it("exposes no HTTP controllers", () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ReliabilityModule) ?? []).toEqual([]);
    expect(Reflect.getMetadata(METHOD_METADATA, AuditService.prototype.record)).toBeUndefined();
    expect(Reflect.getMetadata(METHOD_METADATA, OutboxService.prototype.publish)).toBeUndefined();
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

  it("refuses to publish an event outside a unit of work", async () => {
    const event = defineEvent("system.probe", "probe", {
      probeId: "0199c4a2-7b1e-7c3a-9f00-1234567890ab",
    });
    await expect(new OutboxService().publish({} as never, event)).rejects.toMatchObject({
      code: "OUTBOX_OUTSIDE_TRANSACTION",
    });
  });
});
