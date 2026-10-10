import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import { isIP } from "node:net";
import {
  mediaAssetParamsSchema,
  mediaAssetSchema,
  mediaUploadRequestSchema,
  mediaUploadResponseSchema,
  productMediaResponseSchema,
  productParamsSchema,
  type MediaUploadRequest,
} from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { CATALOG_MANAGE_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { MediaService } from "./media.service";

class UploadDto extends createZodDto(mediaUploadRequestSchema) {}
class CompleteDto extends createZodDto(z.strictObject({})) {}
class ProductParamsDto extends createZodDto(productParamsSchema) {
  declare id: string;
}
class AssetParamsDto extends createZodDto(mediaAssetParamsSchema) {
  declare assetId: string;
}

/** Product image upload authorization and completion (step 48). Nothing here is public. */
@Controller({ path: "admin", version: "1" })
export class MediaController {
  constructor(
    private readonly media: MediaService,
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

  @Get("products/:id/media")
  @RequirePermission("catalog.read")
  @Serialize(productMediaResponseSchema)
  list(
    @Param() params: ProductParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.media.list(request.staff!.userId, params.id);
  }

  @Post("products/:id/media/uploads")
  @HttpCode(201)
  @RequirePermission("catalog.write", "media.upload")
  @Serialize(mediaUploadResponseSchema)
  async authorize(
    @Param() params: ProductParamsDto,
    @Body() body: UploadDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.media.authorize(
      await this.mutation(request, reply),
      params.id,
      body as unknown as MediaUploadRequest,
    );
  }

  @Post("media/:assetId/complete")
  @HttpCode(200)
  @RequirePermission("catalog.write", "media.upload")
  @Serialize(mediaAssetSchema)
  async complete(
    @Param() params: AssetParamsDto,
    @Body() _body: CompleteDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.media.complete(await this.mutation(request, reply), params.assetId);
  }
}
