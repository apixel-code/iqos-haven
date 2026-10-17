import { Body, Controller, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import { isIP } from "node:net";
import {
  adminOrderParamsSchema,
  orderCollectionCorrectionRequestSchema,
  orderCollectionRequestSchema,
  orderCollectionResponseSchema,
  type OrderCollectionCorrectionRequest,
  type OrderCollectionRequest,
} from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { ORDER_COLLECTION_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { AdminOrdersService } from "./admin-orders.service";

class ParamsDto extends createZodDto(adminOrderParamsSchema) {
  declare id: string;
}
class CollectionDto extends createZodDto(orderCollectionRequestSchema) {}
class CorrectionDto extends createZodDto(orderCollectionCorrectionRequestSchema) {}

/**
 * Cash-on-delivery collection (roadmap step 87, ADR 0055): `POST /v1/admin/orders/:id/collection`
 * records the cash of a Delivered order; `POST .../collection/corrections` is the Owner's
 * correction, kept next to the original record.
 */
@Controller({ path: "admin/orders", version: "1" })
export class OrderCollectionController {
  constructor(
    private readonly orders: AdminOrdersService,
    private readonly limits: RateLimitService,
  ) {}

  private async limit(request: AuthenticatedRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      ORDER_COLLECTION_POLICY,
      {
        ip: typeof header === "string" && isIP(header) ? header : request.ip,
        actor: request.staff!.userId,
      },
      request,
      reply,
    );
  }

  @Post(":id/collection")
  @HttpCode(200)
  @RequirePermission("orders.collect")
  @Serialize(orderCollectionResponseSchema)
  async collect(
    @Param() params: ParamsDto,
    @Body() body: CollectionDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.limit(request, reply);
    const input = body as unknown as OrderCollectionRequest;
    return this.orders.collect(
      { requestId: request.id, actorId: request.staff!.userId, commandId: input.commandId },
      params.id,
      input,
    );
  }

  @Post(":id/collection/corrections")
  @HttpCode(200)
  @RequirePermission("orders.collection_correct")
  @Serialize(orderCollectionResponseSchema)
  async correct(
    @Param() params: ParamsDto,
    @Body() body: CorrectionDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.limit(request, reply);
    const input = body as unknown as OrderCollectionCorrectionRequest;
    return this.orders.correctCollection(
      { requestId: request.id, actorId: request.staff!.userId, commandId: input.commandId },
      params.id,
      input,
    );
  }
}
