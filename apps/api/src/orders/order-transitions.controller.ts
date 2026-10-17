import { Body, Controller, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import { isIP } from "node:net";
import {
  adminOrderParamsSchema,
  orderBulkConfirmRequestSchema,
  orderBulkConfirmResponseSchema,
  type OrderBulkConfirmRequest,
  orderTransitionRequestSchema,
  orderTransitionResponseSchema,
  type OrderTransitionRequest,
} from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { ORDER_BULK_CONFIRM_POLICY, ORDER_TRANSITION_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { AdminOrdersService } from "./admin-orders.service";

class ParamsDto extends createZodDto(adminOrderParamsSchema) {
  declare id: string;
}
class TransitionDto extends createZodDto(orderTransitionRequestSchema) {}
class BulkConfirmDto extends createZodDto(orderBulkConfirmRequestSchema) {}

/** Expected-version fulfilment transitions (roadmap step 84). */
@Controller({ path: "admin/orders", version: "1" })
export class OrderTransitionsController {
  constructor(
    private readonly orders: AdminOrdersService,
    private readonly limits: RateLimitService,
  ) {}

  @Post(":id/transitions")
  @HttpCode(200)
  @RequirePermission("orders.transition")
  @Serialize(orderTransitionResponseSchema)
  async transition(
    @Param() params: ParamsDto,
    @Body() body: TransitionDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      ORDER_TRANSITION_POLICY,
      {
        ip: typeof header === "string" && isIP(header) ? header : request.ip,
        actor: request.staff!.userId,
      },
      request,
      reply,
    );
    const input = body as unknown as OrderTransitionRequest;
    return this.orders.transition(
      {
        requestId: request.id,
        actorId: request.staff!.userId,
        commandId: input.commandId,
      },
      params.id,
      input,
    );
  }

  /** `POST /v1/admin/orders/bulk-confirm` (step 89, ADR 0057): one result per order. */
  @Post("bulk-confirm")
  @HttpCode(200)
  @RequirePermission("orders.transition")
  @Serialize(orderBulkConfirmResponseSchema)
  async bulkConfirm(
    @Body() body: BulkConfirmDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      ORDER_BULK_CONFIRM_POLICY,
      {
        ip: typeof header === "string" && isIP(header) ? header : request.ip,
        actor: request.staff!.userId,
      },
      request,
      reply,
    );
    return this.orders.bulkConfirm(
      { requestId: request.id, actorId: request.staff!.userId },
      body as unknown as OrderBulkConfirmRequest,
    );
  }
}
