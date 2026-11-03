import {
  Body,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { orderTrackingRequestSchema, orderTrackingResponseSchema } from "@ih/contracts";
import { readOrderTracking, type Database } from "@ih/db";
import { parseOrderNumber } from "@ih/domain";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { AgeVerified } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { DATABASE } from "../infra/tokens";
import { ORDER_TRACKING_MISS_POLICY, ORDER_TRACKING_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";

class TrackingDto extends createZodDto(orderTrackingRequestSchema) {
  declare orderNumber: string;
}
/** The miss budget shared by every address (ADR 0104). */
const STORE = { store: "all" } as const;

/**
 * `POST /v1/store/order-tracking` (ADR 0104, Marina 2026-11-03): a shopper looks up an order by
 * its number alone. Behind the age ticket like every product view. A number that is malformed,
 * sequential (before ADR 0104) or unknown gets the same 404, and counts against the miss budgets;
 * once those are spent, every lookup from that address (or the store) is refused before the
 * number is looked at, so a refusal never tells a right number from a wrong one.
 */
@Controller({ path: "store/order-tracking", version: "1" })
export class OrderTrackingController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly limits: RateLimitService,
  ) {}
  @Post()
  @HttpCode(200)
  @AgeVerified()
  @Serialize(orderTrackingResponseSchema)
  async track(
    @Body() body: TrackingDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "private, no-store").header("Referrer-Policy", "no-referrer");
    const header = request.headers["x-ih-client-ip"];
    const ip = typeof header === "string" && isIP(header) ? header : request.ip;
    await this.limits.enforce(ORDER_TRACKING_POLICY, { ip }, request, reply);
    await this.limits.assertOpen(ORDER_TRACKING_MISS_POLICY, { ip, ...STORE }, request, reply);
    const orderNumber = parseOrderNumber(body.orderNumber);
    const found = orderNumber === null ? null : await readOrderTracking(this.db, orderNumber);
    if (!found) {
      await this.limits.record(ORDER_TRACKING_MISS_POLICY, { ip, ...STORE });
      throw new NotFoundException();
    }
    return found;
  }
}
