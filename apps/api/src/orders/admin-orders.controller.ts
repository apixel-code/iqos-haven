import { Controller, Get, Param, Query, Req, Res } from "@nestjs/common";
import {
  adminOrderParamsSchema,
  adminOrderResponseSchema,
  adminOrdersQuerySchema,
  adminOrdersResponseSchema,
  type AdminOrdersQuery,
} from "@ih/contracts";
import { defineFieldPolicy } from "@ih/domain";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { AdminOrdersService } from "./admin-orders.service";

class OrdersQueryDto extends createZodDto(adminOrdersQuerySchema) {}
class OrderParamsDto extends createZodDto(adminOrderParamsSchema) {
  declare id: string;
}
const LIST_FIELDS = defineFieldPolicy({ items: { customer: "customers.read" } });
const DETAIL_FIELDS = defineFieldPolicy({ customer: "customers.read" });

/** Snapshot-backed operational order reads (roadmap step 83). */
@Controller({ path: "admin/orders", version: "1" })
@RequirePermission("orders.read")
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

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
}
