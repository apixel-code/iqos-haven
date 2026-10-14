import { Body, Controller, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import { isIP } from "node:net";
import {
  adminOrderParamsSchema,
  orderCancelRequestSchema,
  orderCancelResponseSchema,
  type OrderCancelRequest,
} from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { ORDER_CANCEL_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { AdminOrdersService } from "./admin-orders.service";

class ParamsDto extends createZodDto(adminOrderParamsSchema) {
  declare id: string;
}
class CancelDto extends createZodDto(orderCancelRequestSchema) {}

/**
 * `POST /v1/admin/orders/:id/cancel` (roadmap step 86, ADR 0054). Cancelling before handoff
 * needs `orders.cancel_before_dispatch`; a return after handoff also needs
 * `orders.cancel_after_dispatch`, which the command checks against the order's state.
 */
@Controller({ path: "admin/orders", version: "1" })
export class OrderCancellationController {
  constructor(
    private readonly orders: AdminOrdersService,
    private readonly limits: RateLimitService,
  ) {}

  @Post(":id/cancel")
  @HttpCode(200)
  @RequirePermission("orders.cancel_before_dispatch")
  @Serialize(orderCancelResponseSchema)
  async cancel(
    @Param() params: ParamsDto,
    @Body() body: CancelDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      ORDER_CANCEL_POLICY,
      {
        ip: typeof header === "string" && isIP(header) ? header : request.ip,
        actor: request.staff!.userId,
      },
      request,
      reply,
    );
    const input = body as unknown as OrderCancelRequest;
    return this.orders.cancel(
      { requestId: request.id, actorId: request.staff!.userId, commandId: input.commandId },
      params.id,
      input,
    );
  }
}
