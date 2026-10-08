import { Inject, Injectable } from "@nestjs/common";
import type { ReadinessResponse } from "@ih/contracts";
import { pingDatabase, type Pool } from "@ih/db";
import type Redis from "ioredis";
import { PG_POOL, QUEUE_REDIS } from "../infra/tokens";

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), CHECK_TIMEOUT_MS).unref()),
  ]);
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(QUEUE_REDIS) private readonly redis: Redis,
  ) {}

  async readiness(): Promise<ReadinessResponse> {
    const [database, queue] = await Promise.all([
      withTimeout(pingDatabase(this.pool), false),
      withTimeout(this.pingQueue(), false),
    ]);
    const checks = {
      database: database ? "up" : "down",
      queue: queue ? "up" : "down",
    } as const;
    // Orders can still be accepted without the queue (outbox in Postgres), so queue loss = degraded.
    const status = !database ? "down" : !queue ? "degraded" : "ok";
    return { status, checks };
  }

  private async pingQueue(): Promise<boolean> {
    if (this.redis.status === "wait" || this.redis.status === "end") {
      await this.redis.connect();
    }
    return (await this.redis.ping()) === "PONG";
  }
}
