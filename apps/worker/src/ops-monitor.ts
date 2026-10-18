import { randomUUID } from "node:crypto";
import type { EmailAdapter } from "@ih/application";
import { internalOpsResponseSchema, type InternalOpsResponse } from "@ih/contracts";
import { applyAlertEvaluations, opsSignals, type Database, type OpsSignals } from "@ih/db";
import type { AlertEvaluation, AlertNotice } from "@ih/domain";
import { errorSummary, type Logger } from "@ih/logger";
import { signServiceRequest, type ServiceKey } from "@ih/platform";
import type Redis from "ioredis";
import type { ScheduledJob } from "./scheduler";

/**
 * Ops monitor (roadmap step 125, ADR 0096): every minute the worker reads the architecture §15
 * signals, opens, reminds and resolves alerts in `ops_alerts`, logs every notice and emails the
 * ops recipients. Signals and alerts carry counts and durations only.
 */
export interface RedisSignals {
  reachable: boolean;
  policy: string | null;
  usedMemory: number;
  maxMemory: number;
  evictedKeys: number;
}
export type SyntheticResult = "ok" | "failed" | "skipped";
export interface MonitorInput {
  db: OpsSignals;
  redis: RedisSignals;
  /** null when the API could not be reached; undefined when no API target is configured. */
  api: InternalOpsResponse | null | undefined;
  synthetic: { storefront: SyntheticResult; admin: SyntheticResult };
}

const minutes = (seconds: number) => `${Math.round(seconds / 60)} min`;

/** The §15 rules. `after: 2` = two checks in a row (a minute apart) before an alert opens. */
export function evaluateOps(input: MonitorInput): AlertEvaluation[] {
  const { db, redis, api, synthetic } = input;
  const rule = (key: string, firing: boolean, summary: string, after = 1): AlertEvaluation => ({
    key,
    firing,
    summary,
    after,
  });
  const checkout = api?.checkout;
  const errorRate = checkout && checkout.requests ? checkout.serverErrors / checkout.requests : 0;
  const redisProblem = !redis.reachable
    ? "queue Redis unreachable"
    : redis.policy !== "noeviction"
      ? `queue Redis eviction policy is ${redis.policy ?? "unknown"}`
      : redis.evictedKeys > 0
        ? `${redis.evictedKeys} key(s) evicted`
        : redis.maxMemory > 0 && redis.usedMemory / redis.maxMemory > 0.9
          ? `memory ${Math.round((100 * redis.usedMemory) / redis.maxMemory)}% of its limit`
          : null;
  return [
    rule(
      "effects.backlog",
      db.oldestOpenEffectSeconds > 300,
      `oldest unfinished background effect waits ${minutes(db.oldestOpenEffectSeconds)}`,
    ),
    rule("effects.dead", db.deadEffects > 0, `${db.deadEffects} dead background effect(s)`),
    rule(
      "inventory.ledger",
      db.ledgerMismatches > 0,
      `${db.ledgerMismatches} option(s) differ from the stock ledger`,
    ),
    rule(
      "cache.publication",
      db.oldestOpenRevalidateSeconds > 60,
      `storefront cache invalidation waits ${db.oldestOpenRevalidateSeconds} s`,
    ),
    rule(
      "database.connections",
      db.connections.max > 0 && db.connections.used / db.connections.max > 0.8,
      `${db.connections.used} of ${db.connections.max} database connections in use`,
    ),
    rule("redis.queue", redisProblem !== null, redisProblem ?? "queue Redis healthy"),
    rule(
      "checkout.errors",
      Boolean(checkout && checkout.requests >= 20 && errorRate > 0.02),
      checkout
        ? `${checkout.serverErrors} server error(s) in ${checkout.requests} checkout/quote request(s) over ${minutes(checkout.windowSeconds)}`
        : "checkout counters unavailable",
    ),
    rule(
      "api.ready",
      api === null || (api !== undefined && api.readiness.status !== "ok"),
      api === null
        ? "API unreachable from the worker"
        : `API readiness ${api?.readiness.status ?? "not checked"}`,
      2,
    ),
    rule(
      "synthetic.storefront",
      synthetic.storefront === "failed",
      `storefront check ${synthetic.storefront}`,
      2,
    ),
    rule("synthetic.admin", synthetic.admin === "failed", `admin check ${synthetic.admin}`, 2),
  ];
}

export async function readRedisSignals(redis: Redis): Promise<RedisSignals> {
  try {
    const memory = await redis.info("memory");
    const stats = await redis.info("stats");
    const field = (text: string, name: string) =>
      new RegExp(`^${name}:(.*)$`, "m").exec(text)?.[1]?.trim() ?? null;
    return {
      reachable: true,
      policy: field(memory, "maxmemory_policy"),
      usedMemory: Number(field(memory, "used_memory") ?? 0),
      maxMemory: Number(field(memory, "maxmemory") ?? 0),
      evictedKeys: Number(field(stats, "evicted_keys") ?? 0),
    };
  } catch {
    return { reachable: false, policy: null, usedMemory: 0, maxMemory: 0, evictedKeys: 0 };
  }
}

const OPS_PATH = "/v1/internal/ops";
export async function readApiOps(
  target: { apiUrl: string; key: ServiceKey } | undefined,
  send: typeof fetch = fetch,
): Promise<InternalOpsResponse | null | undefined> {
  if (!target) return undefined;
  try {
    const response = await send(new URL(OPS_PATH, target.apiUrl), {
      headers: signServiceRequest(target.key, { method: "GET", path: OPS_PATH, body: "" }),
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return internalOpsResponseSchema.parse(await response.json());
  } catch {
    return null;
  }
}

/**
 * The §15 availability journey from outside the process: the age gate renders, accepting it sets
 * the ticket and the shop opens with it; the admin sign-in page renders. No order or quote is
 * created; no personal data is sent.
 */
export async function runSynthetic(
  urls: { storefront?: string | undefined; admin?: string | undefined },
  send: typeof fetch = fetch,
): Promise<{ storefront: SyntheticResult; admin: SyntheticResult }> {
  const get = (url: URL, cookie?: string) =>
    send(url, {
      redirect: "manual",
      headers: cookie ? { cookie } : {},
      signal: AbortSignal.timeout(10_000),
    });
  const storefront = async (): Promise<SyntheticResult> => {
    if (!urls.storefront) return "skipped";
    try {
      const base = new URL(urls.storefront);
      const gate = await get(new URL("/age-check", base));
      if (gate.status !== 200 || !(await gate.text()).includes('id="age-accept"')) return "failed";
      const accepted = await send(new URL("/api/age/accept", base), {
        method: "POST",
        redirect: "manual",
        headers: { origin: base.origin, "content-type": "application/x-www-form-urlencoded" },
        body: "return=%2Fshop",
        signal: AbortSignal.timeout(10_000),
      });
      await accepted.body?.cancel().catch(() => undefined);
      const cookie = accepted.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
      if (accepted.status >= 400 || !cookie) return "failed";
      const shop = await get(new URL("/shop", base), cookie);
      await shop.body?.cancel().catch(() => undefined);
      return shop.status === 200 ? "ok" : "failed";
    } catch {
      return "failed";
    }
  };
  const admin = async (): Promise<SyntheticResult> => {
    if (!urls.admin) return "skipped";
    try {
      const page = await get(new URL("/login", urls.admin));
      return page.status === 200 && (await page.text()).includes('name="password"')
        ? "ok"
        : "failed";
    } catch {
      return "failed";
    }
  };
  const [storefrontResult, adminResult] = await Promise.all([storefront(), admin()]);
  return { storefront: storefrontResult, admin: adminResult };
}

/** Logs every notice and emails the ops recipients, outside the outbox (it may be the problem). */
export class OpsAlerter {
  constructor(
    private readonly options: {
      adapter: EmailAdapter;
      from: string;
      recipients: readonly string[];
      appEnv: string;
      log: Logger;
    },
  ) {}

  async notify(notices: readonly AlertNotice[], deliveryKey: string): Promise<void> {
    const { log, recipients } = this.options;
    for (const notice of notices) {
      const fields = { alert: notice.key, kind: notice.kind, summary: notice.summary };
      if (notice.kind === "resolved") log.warn(fields, "ops alert resolved");
      else log.error(fields, "ops alert");
    }
    if (!notices.length || !recipients.length) return;
    try {
      await this.send(this.message(notices), deliveryKey);
    } catch (error) {
      log.error({ ...errorSummary(error), alerts: notices.length }, "ops alert email failed");
    }
  }

  /** `pnpm ops:test-alert`: proves the recipients and the sender path before launch. */
  async test(): Promise<{ accepted: number; rejected: number }> {
    if (!this.options.recipients.length) throw new Error("OPS_ALERT_RECIPIENTS is empty");
    const result = await this.send(
      {
        subject: `[Iqos Haven ${this.options.appEnv}] Test alert`,
        text: "This is a test of the Iqos Haven ops alert email. No action is needed.\n",
      },
      `ops-test-${randomUUID()}`,
    );
    return { accepted: result.accepted, rejected: result.rejected };
  }

  private message(notices: readonly AlertNotice[]) {
    const open = notices.filter((notice) => notice.kind !== "resolved");
    const subject = open.length
      ? `[Iqos Haven ${this.options.appEnv}] ${open.length} alert(s): ${open.map((n) => n.key).join(", ")}`
      : `[Iqos Haven ${this.options.appEnv}] resolved: ${notices.map((n) => n.key).join(", ")}`;
    const lines = notices.map(
      (notice) =>
        `${notice.kind.toUpperCase()} ${notice.key}: ${notice.summary} (open since ${notice.openedAt.toISOString()})`,
    );
    return {
      subject: subject.slice(0, 200),
      text: `${lines.join("\n")}\n\nRunbook: docs/runbooks/incident-and-queue-recovery.md\n`,
    };
  }

  private send(message: { subject: string; text: string }, deliveryKey: string) {
    const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    return this.options.adapter.send(
      {
        deliveryKey,
        from: this.options.from,
        bcc: this.options.recipients,
        subject: message.subject,
        text: message.text,
        html: `<pre>${escape(message.text)}</pre>`,
      },
      AbortSignal.timeout(30_000),
    );
  }
}

export function createOpsMonitorJob(options: {
  db: Database;
  redis: Redis;
  apiTarget: { apiUrl: string; key: ServiceKey } | undefined;
  synthetic: { storefront?: string | undefined; admin?: string | undefined };
  alerter: OpsAlerter;
  remindAfterMs: number;
  log: Logger;
}): ScheduledJob {
  return {
    name: "ops.monitor",
    spec: { kind: "interval", everyMs: 60_000 },
    catchUp: 1,
    maxAttempts: 1,
    async run(slot) {
      const [db, redis, api, synthetic] = await Promise.all([
        opsSignals(options.db),
        readRedisSignals(options.redis),
        readApiOps(options.apiTarget),
        runSynthetic(options.synthetic),
      ]);
      const notices = await applyAlertEvaluations(
        options.db,
        evaluateOps({ db, redis, api, synthetic }),
        new Date(),
        options.remindAfterMs,
      );
      await options.alerter.notify(notices, `ops-${slot.getTime()}`);
    },
  };
}
