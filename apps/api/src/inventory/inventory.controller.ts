import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import { isIP } from "node:net";
import {
  inventoryQuerySchema,
  inventoryResponseSchema,
  inventoryVariantParamsSchema,
  stockAdjustmentRequestSchema,
  stockAdjustmentResponseSchema,
  stockMovementsQuerySchema,
  stockMovementsResponseSchema,
  stockSetRequestSchema,
  stockSetResponseSchema,
  type InventoryQuery,
  type StockAdjustmentRequest,
  type StockMovementsQuery,
  type StockSetRequest,
} from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { INVENTORY_ADJUST_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { InventoryService } from "./inventory.service";

class QueryDto extends createZodDto(inventoryQuerySchema) {}
class MovementsQueryDto extends createZodDto(stockMovementsQuerySchema) {}
class ParamsDto extends createZodDto(inventoryVariantParamsSchema) {
  declare variantId: string;
}
class SetDto extends createZodDto(stockSetRequestSchema) {}
/** Refined object: validated whole by the pipe. */
class AdjustmentDto {
  static readonly schema = stockAdjustmentRequestSchema;
}

/** Inventory read and stock adjustments through the ledger (step 46). */
@Controller({ path: "admin/inventory", version: "1" })
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    private readonly limits: RateLimitService,
  ) {}

  @Get()
  @RequirePermission("inventory.read")
  @Serialize(inventoryResponseSchema)
  list(
    @Query() query: QueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.inventory.list(request.staff!.userId, query as unknown as InventoryQuery);
  }

  @Get(":variantId/movements")
  @RequirePermission("inventory.read")
  @Serialize(stockMovementsResponseSchema)
  movements(
    @Param() params: ParamsDto,
    @Query() query: MovementsQueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.inventory.movements(
      request.staff!.userId,
      params.variantId,
      query as unknown as StockMovementsQuery,
    );
  }

  /** Absolute set from a count with the balance the user saw (step 47). */
  @Post(":variantId/set")
  @HttpCode(200)
  @RequirePermission("inventory.adjust")
  @Serialize(stockSetResponseSchema)
  async set(
    @Param() params: ParamsDto,
    @Body() body: SetDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = body as unknown as StockSetRequest;
    return this.inventory.set(
      await this.mutation(request, reply, input.commandId),
      params.variantId,
      input,
    );
  }

  @Post(":variantId/adjustments")
  @HttpCode(200)
  @RequirePermission("inventory.adjust")
  @Serialize(stockAdjustmentResponseSchema)
  async adjust(
    @Param() params: ParamsDto,
    @Body() body: AdjustmentDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const input = body as unknown as StockAdjustmentRequest;
    return this.inventory.adjust(
      await this.mutation(request, reply, input.commandId),
      params.variantId,
      input,
    );
  }

  private async mutation(request: AuthenticatedRequest, reply: FastifyReply, commandId: string) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      INVENTORY_ADJUST_POLICY,
      {
        ip: typeof header === "string" && isIP(header) ? header : request.ip,
        actor: request.staff!.userId,
      },
      request,
      reply,
    );
    return { requestId: request.id, actorId: request.staff!.userId, commandId };
  }
}
