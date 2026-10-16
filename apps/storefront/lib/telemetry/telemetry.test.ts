import { describe, expect, it } from "vitest";
import type { BrowsingEvent } from "@ih/contracts";
import {
  ANON_LIFETIME_MS,
  anonymousIdFrom,
  createTelemetry,
  isQuietPath,
  outcomeOf,
  PAUSE_MS,
  type SendOutcome,
} from "./queue";

function setup(outcomes: SendOutcome[] = [], enabled = () => true) {
  let clock = 1_000;
  let n = 0;
  const sent: Array<{ batch: BrowsingEvent[]; keepalive: boolean }> = [];
  const telemetry = createTelemetry({
    send: async (batch, keepalive) => {
      sent.push({ batch, keepalive });
      return outcomes.shift() ?? "ok";
    },
    newId: () => `0199e0a0-0000-7000-8000-${String(++n).padStart(12, "0")}`,
    now: () => clock,
    enabled,
    maxQueue: 30,
  });
  return { telemetry, sent, tick: (ms: number) => (clock += ms) };
}
const view = { type: "product_view", productSlug: "lune-air" } as const;

describe("storefront telemetry (step 104)", () => {
  it("sends in batches of at most 20, each event with its own ID", async () => {
    const { telemetry, sent } = setup();
    for (let i = 0; i < 25; i++) telemetry.track(view);
    await telemetry.flush();
    await telemetry.flush(true);
    expect(sent.map((call) => call.batch.length)).toEqual([20, 5]);
    expect(sent[1]!.keepalive).toBe(true);
    const ids = sent.flatMap((call) => call.batch.map((event) => event.id));
    expect(new Set(ids).size).toBe(25);
  });

  it("drops new events when the queue is full, never blocking", () => {
    const { telemetry } = setup();
    for (let i = 0; i < 40; i++) telemetry.track(view);
    expect(telemetry.state()).toMatchObject({ queued: 30, dropped: 10 });
  });

  it("retries a failed batch once with the same IDs, then gives up", async () => {
    const { telemetry, sent } = setup(["retry", "retry"]);
    telemetry.track(view);
    await telemetry.flush();
    await telemetry.flush();
    await telemetry.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.batch[0]!.id).toBe(sent[0]!.batch[0]!.id);
    expect(telemetry.state()).toMatchObject({ queued: 0, dropped: 1 });
  });

  it("treats a thrown send like a failure, and a refusal as final", async () => {
    let calls = 0;
    const telemetry = createTelemetry({
      send: async () => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        return "drop";
      },
      newId: () => "0199e0a0-0000-7000-8000-000000000001",
      now: () => 0,
      enabled: () => true,
    });
    telemetry.track(view);
    await telemetry.flush();
    await telemetry.flush();
    expect(calls).toBe(2);
    expect(telemetry.state()).toMatchObject({ queued: 0, dropped: 1 });
  });

  it("backs off for a minute when the API is overloaded", async () => {
    const { telemetry, sent, tick } = setup(["overloaded"]);
    telemetry.track(view);
    telemetry.track(view);
    await telemetry.flush();
    telemetry.track(view);
    expect(telemetry.state()).toMatchObject({ queued: 0, dropped: 3 });
    tick(PAUSE_MS);
    telemetry.track(view);
    await telemetry.flush();
    expect(sent).toHaveLength(2);
  });

  it("records and sends nothing on checkout, confirmation and review pages", async () => {
    let quiet = false;
    const { telemetry, sent } = setup([], () => !quiet);
    telemetry.track(view);
    quiet = true;
    telemetry.track(view);
    await telemetry.flush();
    // What waited when the shopper reached checkout is dropped, not sent later.
    expect(sent).toHaveLength(0);
    expect(telemetry.state()).toMatchObject({ queued: 0, dropped: 1 });
    for (const path of ["/checkout", "/order-confirmation", "/review"])
      expect(isQuietPath(path)).toBe(true);
    for (const path of ["/", "/shop", "/p/lune-air", "/cart", "/checkouts"])
      expect(isQuietPath(path)).toBe(false);
  });

  it("samples by type when asked", () => {
    let roll = 0;
    const telemetry = createTelemetry({
      send: async () => "ok",
      newId: () => "0199e0a0-0000-7000-8000-000000000001",
      now: () => 0,
      enabled: () => true,
      sample: { product_view: 0.5 },
      random: () => (roll++ % 2 ? 0.9 : 0.1),
    });
    for (let i = 0; i < 4; i++) telemetry.track(view);
    telemetry.track({ type: "search", term: "x", resultCount: 0 });
    expect(telemetry.state().queued).toBe(3);
  });

  it("maps answers to outcomes", () => {
    expect([202, 429, 503, 500, 400, 403, 413].map(outcomeOf)).toEqual([
      "ok",
      "overloaded",
      "overloaded",
      "retry",
      "drop",
      "drop",
      "drop",
    ]);
  });

  it("keeps the anonymous ID for a day, then replaces it", () => {
    const fresh = anonymousIdFrom(null, 0, () => "0199e0a0-0000-7000-8000-00000000000a");
    expect(fresh.save).not.toBeNull();
    const kept = anonymousIdFrom(fresh.save, ANON_LIFETIME_MS - 1, () => "other");
    expect(kept).toEqual({ id: fresh.id, save: null });
    const rotated = anonymousIdFrom(
      fresh.save,
      ANON_LIFETIME_MS,
      () => "0199e0a0-0000-7000-8000-00000000000b",
    );
    expect(rotated.id).not.toBe(fresh.id);
    expect(
      anonymousIdFrom("{bad", 0, () => "0199e0a0-0000-7000-8000-00000000000c").save,
    ).not.toBeNull();
  });
});
