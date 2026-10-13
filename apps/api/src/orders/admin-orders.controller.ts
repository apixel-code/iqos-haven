import { Body, Controller, Get, HttpCode, Param, Patch, Query, Req, Res } from "@nestjs/common";
import { isIP } from "node:net";
import {
  adminOrderParamsSchema,
  adminOrderResponseSchema,
  adminOrdersQuerySchema,
  adminOrdersResponseSchema,
  orderEditRequestSchema,
  orderEditResponseSchema,
  type OrderEditRequest,
  type AdminOrdersQuery,
} from "@ih/contracts";
import { defineFieldPolicy } from "@ih/domain";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { AdminOrdersService } from "./admin-orders.service";
import { ORDER_EDIT_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";

class OrdersQueryDto extends createZodDto(adminOrdersQuerySchema) {}
class OrderParamsDto extends createZodDto(adminOrderParamsSchema) {
  declare id: string;
}
class OrderEditDto {
  static readonly schema = orderEditRequestSchema;
}
const LIST_FIELDS = defineFieldPolicy({ items: { customer: "customers.read" } });
const DETAIL_FIELDS = defineFieldPolicy({
  customer: "customers.read",
  area: { id: "orders.edit" },
  items: { variantId: "orders.edit" },
});

/** Snapshot-backed operational order reads (roadmap step 83). */
@Controller({ path: "admin/orders", version: "1" })
@RequirePermission("orders.read")
export class AdminOrdersController {
  constructor(
    private readonly orders: AdminOrdersService,
    private readonly limits: RateLimitService,
  ) {}

  @Get()
  @Serialize(adminOrdersResponseSchema, LIST_FIELDS)
  list(
    @Query() query: OrdersQueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "private, no-store");
    return this.orders.list(request.staff!.userId, query as unknown as AdminOrdersQuery);
  }

  @Get(":id")
  @Serialize(adminOrderResponseSchema, DETAIL_FIELDS)
  find(
    @Param() params: OrderParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "private, no-store");
    return this.orders.find(request.staff!.userId, params.id);
  }

  @Patch(":id")
  @HttpCode(200)
  @RequirePermission("orders.edit")
  @Serialize(orderEditResponseSchema)
  async edit(
    @Param() params: OrderParamsDto,
    @Body() body: OrderEditDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      ORDER_EDIT_POLICY,
      {
        ip: typeof header === "string" && isIP(header) ? header : request.ip,
        actor: request.staff!.userId,
      },
      request,
      reply,
    );
    const input = body as unknown as OrderEditRequest;
    return this.orders.edit(
      { requestId: request.id, actorId: request.staff!.userId, commandId: input.commandId },
      params.id,
      input,
    );
  }
}
