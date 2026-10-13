import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { ApiEnv } from "@ih/config";
import {
  storeOrderRequestSchema,
  storeOrderResponseSchema,
  type CheckoutAddress,
  type CheckoutContact,
  type OrderLines,
} from "@ih/contracts";
import {
  CouponRejectedError,
  IdempotencyConflictError,
  IdempotencyExpiredError,
  IdempotencyInProgressError,
  InsufficientStockError,
  isIdempotencyKey,
  QuoteNotAcceptedError,
  TransactionContentionError,
  VariantUnavailableError,
} from "@ih/db";
import { DeliveryUnavailableError, DeliveryUnconfiguredError } from "@ih/domain";
import type { EndpointLimitPolicy } from "@ih/platform";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { AgeVerified } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { requestId } from "../http/request-id";
import { createZodDto } from "../http/zod-validation.pipe";
import { API_ENV } from "../infra/tokens";
import { checkoutPolicy, couponFailurePolicy } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { CreateOrderService } from "./create-order.service";

class OrderDto extends createZodDto(storeOrderRequestSchema) {
  declare contact: CheckoutContact;
  declare address: CheckoutAddress;
  declare lines: OrderLines;
  declare couponCode: string | null;
  declare quoteToken: string;
  declare ageConfirmed: true;
}
/**
 * One stable code per refusal the shopper can act on (architecture §7). Never the detailed
 * reason, a variant, a coupon, or the order an old key belongs to.
 */
function refusalCode(error: unknown): string | undefined {
  if (error instanceof QuoteNotAcceptedError) return error.code;
  if (error instanceof InsufficientStockError) return error.code;
  if (error instanceof VariantUnavailableError) return "VARIANT_UNAVAILABLE";
  if (error instanceof DeliveryUnavailableError || error instanceof DeliveryUnconfiguredError)
    return "AREA_UNAVAILABLE";
  if (error instanceof CouponRejectedError) return error.code;
  if (
    error instanceof IdempotencyConflictError ||
    error instanceof IdempotencyInProgressError ||
    error instanceof IdempotencyExpiredError
  )
    return error.code;
  return undefined;
}
/**
 * `POST /v1/store/orders` (roadmap step 77, ADR 0046): the only way a shopper places an order.
 * Behind the age ticket and the store Origin check, off until `CHECKOUT_SUBMISSION_ENABLED`,
 * limited per address and per phone. It validates, limits and translates; every rule about the
 * order itself is in `CreateOrderService.place`, which makes no network call.
 */
@Controller({ path: "store/orders", version: "1" })
export class StoreOrdersController {
  private readonly checkout: EndpointLimitPolicy<"ip" | "phone">;
  private readonly couponFailures: EndpointLimitPolicy<"ip">;
  constructor(
    private readonly orders: CreateOrderService,
    private readonly limits: RateLimitService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {
    this.checkout = checkoutPolicy(env);
    this.couponFailures = couponFailurePolicy(env);
  }
  @Post()
  @HttpCode(201)
  @AgeVerified()
  @Serialize(storeOrderResponseSchema)
  async place(
    @Body() body: OrderDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");
    if (!this.env.CHECKOUT_SUBMISSION_ENABLED) throw new ServiceUnavailableException();
    if (!isIdempotencyKey(idempotencyKey))
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        details: [{ path: "idempotencyKey", message: "Invalid field" }],
      });
    const header = request.headers["x-ih-client-ip"];
    const ip = typeof header === "string" && isIP(header) ? header : request.ip;
    // Every attempt counts, whatever its outcome, a retry of a placed order included.
    await this.limits.enforce(this.checkout, { ip, phone: body.contact.phone }, request, reply);
    if (body.couponCode) await this.limits.assertOpen(this.couponFailures, { ip }, request, reply);
    try {
      const placed = await this.orders.place({
        idempotencyKey,
        contact: body.contact,
        address: body.address,
        lines: body.lines,
        couponCode: body.couponCode,
        quoteToken: body.quoteToken,
        requestId: requestId(request.raw as typeof request.raw & { id?: string }),
      });
      return placed.response;
    } catch (error) {
      if (error instanceof CouponRejectedError)
        await this.limits.record(this.couponFailures, { ip });
      // Both mean "try the same request again shortly": nothing was decided.
      if (
        error instanceof IdempotencyInProgressError ||
        error instanceof TransactionContentionError
      )
        reply.header("Retry-After", "1");
      const code = refusalCode(error);
      if (code) throw new ConflictException({ code });
      throw error;
    }
  }
}
