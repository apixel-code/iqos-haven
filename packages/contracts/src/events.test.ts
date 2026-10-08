import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AGGREGATE_TYPE_PATTERN,
  CONSUMERS,
  EVENT_CATALOGUE,
  EVENT_TYPE_PATTERN,
  defineEvent,
  effectJobId,
  isEventType,
} from "./events";

const entries = Object.entries(EVENT_CATALOGUE);

describe("event catalogue", () => {
  it("covers the architecture §8 initial events plus the synthetic probe", () => {
    expect(Object.keys(EVENT_CATALOGUE).sort()).toEqual(
      [
        "catalog.changed",
        "content.published",
        "inventory.low",
        "media.uploaded",
        "order.cancelled",
        "order.collection_recorded",
        "order.created",
        "order.status_changed",
        "order.updated",
        "report.requested",
        "review.submitted",
        "system.probe",
      ].sort(),
    );
  });

  it.each(entries)("%s matches the database shape constraints", (type, definition) => {
    expect(type).toMatch(EVENT_TYPE_PATTERN);
    expect(definition.aggregateType).toMatch(AGGREGATE_TYPE_PATTERN);
    expect(Number.isSafeInteger(definition.schemaVersion) && definition.schemaVersion > 0).toBe(
      true,
    );
  });

  it.each(entries)("%s has a known, duplicate-free required consumer set", (_type, definition) => {
    const required = definition.consumers as readonly string[];
    const planned = Object.keys(definition.plannedConsumers);
    expect(new Set(required).size).toBe(required.length);
    for (const consumer of [...required, ...planned])
      expect(CONSUMERS as readonly string[]).toContain(consumer);
    for (const step of Object.values(definition.plannedConsumers))
      expect(Number.isInteger(step) && step! > 19 && step! <= 132).toBe(true);
    // A consumer moves from planned to required; it is never both.
    expect(required.filter((consumer) => planned.includes(consumer))).toEqual([]);
  });

  it("only wires consumers whose handlers exist (step 19: the synthetic probe)", () => {
    const wired = entries.flatMap(([, definition]) => definition.consumers as readonly string[]);
    expect([...new Set(wired)]).toEqual(["system_probe"]);
  });
});

describe("defineEvent", () => {
  const orderId = randomUUID();

  it("snapshots schema version, aggregate and required consumers", () => {
    const event = defineEvent("system.probe", "probe", { probeId: orderId }, 3);
    expect(event).toEqual({
      type: "system.probe",
      schemaVersion: 1,
      aggregateType: "system",
      aggregateId: "probe",
      aggregateVersion: 3,
      payload: { probeId: orderId },
      consumers: ["system_probe"],
    });
    expect(event.consumers).not.toBe(EVENT_CATALOGUE["system.probe"].consumers);
  });

  it("rejects personal data and unknown payload fields", () => {
    expect(() =>
      defineEvent("order.created", orderId, { orderId, phone: "+971500000000" } as never),
    ).toThrow();
    expect(() => defineEvent("order.created", orderId, { orderId: "ORD-1" })).toThrow();
  });

  it("validates status values, aggregate ID and version", () => {
    expect(() =>
      defineEvent("order.status_changed", orderId, {
        orderId,
        from: "pending",
        to: "collected" as never,
      }),
    ).toThrow();
    expect(() => defineEvent("order.created", "", { orderId })).toThrow(RangeError);
    expect(() => defineEvent("order.created", orderId, { orderId }, -1)).toThrow(RangeError);
    expect(() => defineEvent("order.created", orderId, { orderId }, 1.5)).toThrow(RangeError);
  });

  it("recognises catalogue types and builds stable job IDs", () => {
    expect(isEventType("order.created")).toBe(true);
    expect(isEventType("toString")).toBe(false);
    expect(effectJobId("e1", "notification")).toBe(effectJobId("e1", "notification"));
    expect(effectJobId("e1", "notification")).not.toBe(effectJobId("e1", "email"));
  });
});
