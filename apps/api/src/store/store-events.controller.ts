import { Body, Controller, HttpCode, Inject, Post, Req, Res } from "@nestjs/common";
import {
  storeEventsRequestSchema,
  storeEventsResponseSchema,
  type StoreEventsRequest,
} from "@ih/contracts";
import { storeBrowsingEvents, type Database } from "@ih/db";
import { createLogger } from "@ih/logger";
import type { ApiEnv } from "@ih/config";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { AgeVerified } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { API_ENV, DATABASE } from "../infra/tokens";
import { STORE_EVENTS_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";

class EventsDto extends createZodDto(storeEventsRequestSchema) {
  declare anonymousId?: string;
  declare events: StoreEventsRequest["events"];
}

/** Batches written at once per process; more are dropped so telemetry never queues up. */
export const MAX_CONCURRENT_EVENT_WRITES = 2;

/**
 * `POST /v1/store/events` (roadmap step 103, ADR 0069): anonymous browsing events, best effort.
 * Behind the age ticket and the store Origin rules, limited per address, at most 20 events and
 * 8 KB per batch. Always 202: a batch shed under load or after a database error is reported as
 * dropped, never as a failure the shop has to handle. Nothing about the shopper is stored.
 */
@Controller({ path: "store/events", version: "1" })
export class StoreEventsController {
  private writing = 0;
  private readonly log;
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly limits: RateLimitService,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    this.log = createLogger({ service: "api-store-events", level: env.LOG_LEVEL });
  }

  @Post()
  @HttpCode(202)
  @AgeVerified()
  @Serialize(storeEventsResponseSchema)
  async collect(
    @Body() body: EventsDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      STORE_EVENTS_POLICY,
      { ip: typeof header === "string" && isIP(header) ? header : request.ip },
      request,
      reply,
    );
    const all = { stored: 0, duplicate: 0, dropped: body.events.length };
    if (this.writing >= MAX_CONCURRENT_EVENT_WRITES) return all;
    this.writing += 1;
    try {
      return await storeBrowsingEvents(this.db, body as StoreEventsRequest);
    } catch (error) {
      // Best effort: the shop never sees a telemetry failure. Logged without the batch.
      this.log.warn(
        { errorKind: error instanceof Error ? error.name : "unknown" },
        "events dropped",
      );
      return all;
    } finally {
      this.writing -= 1;
    }
  }
}
