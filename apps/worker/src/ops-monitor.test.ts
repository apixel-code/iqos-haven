import type { EmailMessage } from "@ih/application";
import { describe, expect, it, vi } from "vitest";
import { evaluateOps, OpsAlerter, runSynthetic, type MonitorInput } from "./ops-monitor";

const healthy: MonitorInput = {
  db: {
    oldestOpenEffectSeconds: 20,
    deadEffects: 0,
    oldestOpenRevalidateSeconds: 0,
    ledgerMismatches: 0,
    connections: { used: 12, max: 100 },
  },
  redis: { reachable: true, policy: "noeviction", usedMemory: 10, maxMemory: 100, evictedKeys: 0 },
  api: {
    checkout: { requests: 50, serverErrors: 1, windowSeconds: 600 },
    readiness: { status: "ok", checks: { database: "up", queue: "up" } },
  },
  synthetic: { storefront: "ok", admin: "ok" },
};
const firing = (input: MonitorInput) =>
  evaluateOps(input)
    .filter((rule) => rule.firing)
    .map((rule) => rule.key);

describe("ops monitor rules (step 125, architecture §15)", () => {
  it("is quiet when everything is healthy", () => {
    expect(firing(healthy)).toEqual([]);
    expect(evaluateOps(healthy).map((rule) => rule.key)).toHaveLength(10);
  });

  it("fires each rule on its threshold", () => {
    expect(
      firing({
        ...healthy,
        db: {
          oldestOpenEffectSeconds: 301,
          deadEffects: 1,
          oldestOpenRevalidateSeconds: 61,
          ledgerMismatches: 2,
          connections: { used: 81, max: 100 },
        },
        redis: { ...healthy.redis, policy: "allkeys-lru" },
        api: {
          checkout: { requests: 40, serverErrors: 1, windowSeconds: 600 },
          readiness: { status: "degraded", checks: { database: "up", queue: "down" } },
        },
        synthetic: { storefront: "failed", admin: "failed" },
      }),
    ).toEqual([
      "effects.backlog",
      "effects.dead",
      "inventory.ledger",
      "cache.publication",
      "database.connections",
      "redis.queue",
      "checkout.errors",
      "api.ready",
      "synthetic.storefront",
      "synthetic.admin",
    ]);
  });

  it("needs a minimum sample for the checkout error rate, and two failures for availability", () => {
    expect(
      firing({
        ...healthy,
        api: { ...healthy.api!, checkout: { requests: 19, serverErrors: 5, windowSeconds: 600 } },
      }),
    ).toEqual([]);
    const rules = evaluateOps({ ...healthy, api: null });
    expect(rules.find((rule) => rule.key === "api.ready")).toMatchObject({
      firing: true,
      after: 2,
      summary: "API unreachable from the worker",
    });
    // Not configured is not a failure.
    expect(
      firing({
        ...healthy,
        api: undefined,
        synthetic: { storefront: "skipped", admin: "skipped" },
      }),
    ).toEqual([]);
  });

  it("reports Redis trouble in order of severity", () => {
    const summary = (redis: MonitorInput["redis"]) =>
      evaluateOps({ ...healthy, redis }).find((rule) => rule.key === "redis.queue")!.summary;
    expect(summary({ ...healthy.redis, reachable: false })).toBe("queue Redis unreachable");
    expect(summary({ ...healthy.redis, evictedKeys: 3 })).toBe("3 key(s) evicted");
    expect(summary({ ...healthy.redis, usedMemory: 95 })).toBe("memory 95% of its limit");
  });
});

describe("synthetic check", () => {
  const page = (status: number, body = "", headers: Record<string, string> = {}) =>
    new Response(body, { status, headers });

  it("walks age gate → accept → shop, and the admin sign-in page", async () => {
    const calls: string[] = [];
    const send = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/age-check") return page(200, '<form id="age-accept">');
      if (url.pathname === "/api/age/accept") {
        expect((init?.headers as Record<string, string>).origin).toBe("https://shop.test");
        return page(303, "", {
          "set-cookie": "ih_age=ticket; Path=/; HttpOnly",
          location: "/shop",
        });
      }
      if (url.pathname === "/shop") {
        expect((init?.headers as Record<string, string>).cookie).toBe("ih_age=ticket");
        return page(200);
      }
      if (url.pathname === "/login") return page(200, '<input name="password">');
      return page(404);
    }) as unknown as typeof fetch;
    expect(
      await runSynthetic({ storefront: "https://shop.test", admin: "https://admin.test" }, send),
    ).toEqual({ storefront: "ok", admin: "ok" });
    expect(calls).toEqual(
      expect.arrayContaining(["GET /age-check", "POST /api/age/accept", "GET /shop", "GET /login"]),
    );
  });

  it("fails when a step breaks, and skips what is not configured", async () => {
    const noCookie = (async (input: URL | string | Request) =>
      new URL(String(input)).pathname === "/age-check"
        ? page(200, '<form id="age-accept">')
        : page(303)) as unknown as typeof fetch;
    expect(await runSynthetic({ storefront: "https://shop.test" }, noCookie)).toEqual({
      storefront: "failed",
      admin: "skipped",
    });
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(
      await runSynthetic({ storefront: "https://s.test", admin: "https://a.test" }, down),
    ).toEqual({
      storefront: "failed",
      admin: "failed",
    });
  });
});

describe("ops alerter", () => {
  const log = () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() });
  const notice = (kind: "opened" | "resolved") => ({
    key: "effects.dead",
    kind,
    summary: "2 dead background effect(s)",
    openedAt: new Date("2026-10-18T08:00:00Z"),
  });

  it("logs every notice and sends one email to the recipients", async () => {
    const sent: EmailMessage[] = [];
    const logger = log();
    const alerter = new OpsAlerter({
      adapter: {
        send: async (message) => {
          sent.push(message);
          return { receipt: "r", accepted: 1, rejected: 0 };
        },
      },
      from: "no-reply@iqoshaven.com",
      recipients: ["ops@apixel.test"],
      appEnv: "production",
      log: logger as never,
    });
    await alerter.notify([notice("opened")], "ops-1");
    expect(logger.error).toHaveBeenCalledWith(
      { alert: "effects.dead", kind: "opened", summary: "2 dead background effect(s)" },
      "ops alert",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      deliveryKey: "ops-1",
      bcc: ["ops@apixel.test"],
      subject: "[Iqos Haven production] 1 alert(s): effects.dead",
    });
    expect(sent[0]!.text).toContain("OPENED effects.dead: 2 dead background effect(s)");
    await alerter.notify([notice("resolved")], "ops-2");
    expect(sent[1]!.subject).toBe("[Iqos Haven production] resolved: effects.dead");
    await alerter.notify([], "ops-3");
    expect(sent).toHaveLength(2);
  });

  it("keeps alerts in the logs when there are no recipients or the email fails", async () => {
    const send = vi.fn(async () => {
      throw new Error("SMTP down");
    });
    const logger = log();
    await new OpsAlerter({
      adapter: { send },
      from: "no-reply@iqoshaven.com",
      recipients: [],
      appEnv: "staging",
      log: logger as never,
    }).notify([notice("opened")], "ops-1");
    expect(send).not.toHaveBeenCalled();
    await new OpsAlerter({
      adapter: { send },
      from: "no-reply@iqoshaven.com",
      recipients: ["ops@apixel.test"],
      appEnv: "staging",
      log: logger as never,
    }).notify([notice("opened")], "ops-2");
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ alerts: 1 }),
      "ops alert email failed",
    );
  });
});
