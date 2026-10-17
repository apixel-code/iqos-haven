import { Controller, Get, Inject, Query, Res } from "@nestjs/common";
import {
  orderItemChoicesQuerySchema,
  orderItemChoicesResponseSchema,
  type OrderItemChoicesQuery,
} from "@ih/contracts";
import { searchOrderItemChoices, type Database } from "@ih/db";
import type { FastifyReply } from "fastify";
import { RequireAnyPermission } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { DATABASE } from "../infra/tokens";

class QueryDto extends createZodDto(orderItemChoicesQuerySchema) {}

/**
 * `GET /v1/admin/orders/item-choices` (parity G-A1, ADR 0080): the product/variant picker of
 * the manual order (`orders.create`) and the order edit (`orders.edit`). Either right is
 * enough; it shows nothing a shopper could not see, and stock only as sold out or not.
 */
@Controller({ path: "admin/orders", version: "1" })
export class OrderItemChoicesController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get("item-choices")
  @RequireAnyPermission("orders.create", "orders.edit")
  @Serialize(orderItemChoicesResponseSchema)
  choices(@Query() query: QueryDto, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    return searchOrderItemChoices(this.db, query as unknown as OrderItemChoicesQuery);
  }
}
