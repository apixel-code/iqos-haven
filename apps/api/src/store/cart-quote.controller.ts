import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { ApiEnv } from "@ih/config";
import {
  COUPON_INVALID,
  COUPON_LIMIT_REACHED,
  storeQuoteRequestSchema,
  storeQuoteResponseSchema,
  type StoreQuoteRequest,
} from "@ih/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { AgeVerified } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import type { EndpointLimitPolicy } from "@ih/platform";
import { API_ENV } from "../infra/tokens";
import { couponFailurePolicy, STORE_QUOTE_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { CartQuoteService } from "./cart-quote.service";

class QuoteDto extends createZodDto(storeQuoteRequestSchema) {
  declare lines: StoreQuoteRequest["lines"];
  declare areaId: string;
  declare couponCode: StoreQuoteRequest["couponCode"];
}
/**
 * `POST /v1/store/cart/quote` (roadmap step 71). A POST because it carries a cart, not because
 * it changes anything: it reserves no stock and uses no coupon. Behind the age ticket, limited
 * per address, never cached. Wrong coupon codes use a second, smaller budget shared with the
 * order route (step 77).
 */
@Controller({ path: "store/cart/quote", version: "1" })
export class CartQuoteController {
  private readonly couponFailures: EndpointLimitPolicy<"ip">;
  constructor(
    private readonly quotes: CartQuoteService,
    private readonly limits: RateLimitService,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    this.couponFailures = couponFailurePolicy(env);
  }
  @Post()
  @HttpCode(200)
  @AgeVerified()
  @Serialize(storeQuoteResponseSchema)
  async quote(
    @Body() body: QuoteDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");
    const header = request.headers["x-ih-client-ip"];
    const ip = typeof header === "string" && isIP(header) ? header : request.ip;
    await this.limits.enforce(STORE_QUOTE_POLICY, { ip }, request, reply);
    if (body.couponCode) await this.limits.assertOpen(this.couponFailures, { ip }, request, reply);
    try {
      return await this.quotes.quote(body);
    } catch (error) {
      const response = error instanceof ConflictException ? error.getResponse() : null;
      const code = response && typeof response === "object" && "code" in response && response.code;
      if (code === COUPON_INVALID || code === COUPON_LIMIT_REACHED)
        await this.limits.record(this.couponFailures, { ip });
      throw error;
    }
  }
}
