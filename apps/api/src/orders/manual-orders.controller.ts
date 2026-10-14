import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { isIP } from "node:net";
import {
  manualOrderRequestSchema,
  manualOrderResponseSchema,
  MANUAL_CONFIRMATION_CHANNELS,
  storeDeliveryResponseSchema,
  storeQuoteRequestSchema,
  storeQuoteResponseSchema,
  type CheckoutAddress,
  type CheckoutContact,
  type OrderLines,
  type StoreDeliveryResponse,
  type StoreQuoteRequest,
} from "@ih/contracts";
import {
  IdempotencyInProgressError,
  isIdempotencyKey,
  ManualOrderEvidenceError,
  OrderCreateForbiddenError,
  readStoreDelivery,
  TransactionContentionError,
  type Database,
} from "@ih/db";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { DATABASE } from "../infra/tokens";
import { MANUAL_ORDER_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { CartQuoteService } from "../store/cart-quote.service";
import { CreateOrderService } from "./create-order.service";
import { refusalCode } from "./order-refusals";

class QuoteDto extends createZodDto(storeQuoteRequestSchema) {}
class ManualOrderDto extends createZodDto(manualOrderRequestSchema) {}
type ManualOrderInput = {
  contact: CheckoutContact;
  address: CheckoutAddress;
  lines: OrderLines;
  couponCode: string | null;
  quoteToken: string;
  start: "pending" | "confirmed";
  evidence?: { channel: (typeof MANUAL_CONFIRMATION_CHANNELS)[number]; note: string };
};
const CHANNEL_TEXT: Record<(typeof MANUAL_CONFIRMATION_CHANNELS)[number], string> = {
  phone: "phone call",
  whatsapp: "WhatsApp",
  in_person: "in person",
};

/**
 * Manual orders (roadmap step 88, ADR 0056): a staff member enters an order for a customer.
 * The same delivery choices, server quote and order transaction as the storefront; the attempt
 * key is scoped to the staff member. `orders.create`; starting Confirmed also needs
 * `orders.transition` and the confirmation evidence.
 */
@Controller({ path: "admin/orders", version: "1" })
@RequirePermission("orders.create")
export class ManualOrdersController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly quotes: CartQuoteService,
    private readonly orders: CreateOrderService,
    private readonly limits: RateLimitService,
  ) {}

  private async limit(request: AuthenticatedRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      MANUAL_ORDER_POLICY,
      {
        ip: typeof header === "string" && isIP(header) ? header : request.ip,
        actor: request.staff!.userId,
      },
      request,
      reply,
    );
  }

  /** Active delivery areas, the fee and the ETA, for the order form. */
  @Get("delivery-areas")
  @Serialize(storeDeliveryResponseSchema)
  async areas(@Res({ passthrough: true }) reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    return (await readStoreDelivery(this.db)) as StoreDeliveryResponse;
  }

  /** The authoritative total, and the token to place the order with. Nothing is reserved. */
  @Post("quote")
  @HttpCode(200)
  @Serialize(storeQuoteResponseSchema)
  async quote(
    @Body() body: QuoteDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.limit(request, reply);
    return this.quotes.quote(body as unknown as StoreQuoteRequest);
  }

  @Post()
  @HttpCode(201)
  @Serialize(manualOrderResponseSchema)
  async create(
    @Body() body: ManualOrderDto,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.limit(request, reply);
    if (!isIdempotencyKey(idempotencyKey))
      throw new BadRequestException({
        code: "VALIDATION_ERROR",
        details: [{ path: "idempotencyKey", message: "Invalid field" }],
      });
    const input = body as unknown as ManualOrderInput;
    try {
      const placed = await this.orders.place({
        idempotencyKey,
        contact: input.contact,
        address: input.address,
        lines: input.lines,
        couponCode: input.couponCode,
        quoteToken: input.quoteToken,
        requestId: request.id,
        manual: {
          actorId: request.staff!.userId,
          start: input.start,
          evidence: input.evidence
            ? `Confirmed by ${CHANNEL_TEXT[input.evidence.channel]}: ${input.evidence.note}`
            : null,
        },
      });
      return { ...placed.response, replayed: placed.replayed };
    } catch (error) {
      if (error instanceof OrderCreateForbiddenError) throw new ForbiddenException();
      if (error instanceof ManualOrderEvidenceError)
        throw new BadRequestException({
          code: "VALIDATION_ERROR",
          details: [{ path: "evidence", message: "Invalid field" }],
        });
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
