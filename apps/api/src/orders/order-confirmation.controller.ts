import { createZodDto } from "../http/zod-validation.pipe";
import { Controller, Get, Query, Req, Res, UnauthorizedException } from "@nestjs/common";
import { orderConfirmationResponseSchema, orderConfirmationQuerySchema } from "@ih/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { Public } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { RateLimitService } from "../security/rate-limit.service";
import { ORDER_CONFIRMATION_POLICY } from "../security/limit-policies";
import { OrderConfirmationService } from "./order-confirmation.service";
class ConfirmationQueryDto extends createZodDto(orderConfirmationQuerySchema) {}
@Controller({ path: "store/order-confirmation", version: "1" })
export class OrderConfirmationController {
  constructor(
    private readonly confirmations: OrderConfirmationService,
    private readonly limits: RateLimitService,
  ) {}
  @Get()
  @Public()
  @Serialize(orderConfirmationResponseSchema)
  async read(
    @Query() _query: ConfirmationQueryDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply
      .header("Cache-Control", "private, no-store")
      .header("Vary", "Cookie")
      .header("Referrer-Policy", "no-referrer");
    const header = request.headers["x-ih-client-ip"];
    const ip = typeof header === "string" && isIP(header) ? header : request.ip;
    await this.limits.enforce(ORDER_CONFIRMATION_POLICY, { ip }, request, reply);
    const value = await this.confirmations.find(request.headers.cookie);
    if (!value) throw new UnauthorizedException();
    return value;
  }
}
