import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import { isIP } from "node:net";
import {
  productParamsSchema,
  productPurgeResponseSchema,
  productReadinessSchema,
  productStateRequestSchema,
  type ProductStateRequest,
} from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { CATALOG_MANAGE_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { PublicationService } from "./publication.service";

class StateDto extends createZodDto(productStateRequestSchema) {}
class ParamsDto extends createZodDto(productParamsSchema) {
  declare id: string;
}

/**
 * Product publication (step 51). Staff may publish/unpublish (`catalog.publish`) and
 * trash/restore (`catalog.trash`); permanent purge is Owner-only (`catalog.purge`).
 */
@Controller({ path: "admin/products", version: "1" })
export class PublicationController {
  constructor(
    private readonly publication: PublicationService,
    private readonly limits: RateLimitService,
  ) {}

  private async mutation(request: AuthenticatedRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      CATALOG_MANAGE_POLICY,
      {
        ip: typeof header === "string" && isIP(header) ? header : request.ip,
        actor: request.staff!.userId,
      },
      request,
      reply,
    );
    return { requestId: request.id, actorId: request.staff!.userId };
  }

  @Get(":id/readiness")
  @RequirePermission("catalog.read")
  @Serialize(productReadinessSchema)
  readiness(
    @Param() params: ParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.publication.readiness(request.staff!.userId, params.id);
  }

  @Post(":id/publish")
  @HttpCode(200)
  @RequirePermission("catalog.publish")
  @Serialize(productReadinessSchema)
  async publish(
    @Param() p: ParamsDto,
    @Body() b: StateDto,
    @Req() r: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.publication.change(
      await this.mutation(r, reply),
      p.id,
      "publish",
      b as unknown as ProductStateRequest,
    );
  }

  @Post(":id/unpublish")
  @HttpCode(200)
  @RequirePermission("catalog.publish")
  @Serialize(productReadinessSchema)
  async unpublish(
    @Param() p: ParamsDto,
    @Body() b: StateDto,
    @Req() r: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.publication.change(
      await this.mutation(r, reply),
      p.id,
      "unpublish",
      b as unknown as ProductStateRequest,
    );
  }

  @Post(":id/trash")
  @HttpCode(200)
  @RequirePermission("catalog.trash")
  @Serialize(productReadinessSchema)
  async trash(
    @Param() p: ParamsDto,
    @Body() b: StateDto,
    @Req() r: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.publication.change(
      await this.mutation(r, reply),
      p.id,
      "trash",
      b as unknown as ProductStateRequest,
    );
  }

  @Post(":id/restore")
  @HttpCode(200)
  @RequirePermission("catalog.trash")
  @Serialize(productReadinessSchema)
  async restore(
    @Param() p: ParamsDto,
    @Body() b: StateDto,
    @Req() r: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.publication.change(
      await this.mutation(r, reply),
      p.id,
      "restore",
      b as unknown as ProductStateRequest,
    );
  }

  @Post(":id/purge")
  @HttpCode(200)
  @RequirePermission("catalog.purge")
  @Serialize(productPurgeResponseSchema)
  async purge(
    @Param() p: ParamsDto,
    @Body() b: StateDto,
    @Req() r: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.publication.purge(
      await this.mutation(r, reply),
      p.id,
      b as unknown as ProductStateRequest,
    );
  }
}
