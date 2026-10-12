import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import {
  storeQuoteRequestSchema,
  storeQuoteResponseSchema,
  type StoreQuoteRequest,
} from "@ih/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { AgeVerified } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { STORE_QUOTE_POLICY } from "../security/limit-policies";
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
 * per address, never cached.
 */
@Controller({ path: "store/cart/quote", version: "1" })
export class CartQuoteController {
  constructor(
    private readonly quotes: CartQuoteService,
    private readonly limits: RateLimitService,
  ) {}
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
    await this.limits.enforce(
      STORE_QUOTE_POLICY,
      { ip: typeof header === "string" && isIP(header) ? header : request.ip },
      request,
      reply,
    );
    return this.quotes.quote(body);
  }
}
