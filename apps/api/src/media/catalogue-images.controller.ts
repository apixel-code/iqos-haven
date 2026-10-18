import { Body, Controller, Get, HttpCode, Param, Post, Req, Res } from "@nestjs/common";
import { isIP } from "node:net";
import {
  catalogueImageResponseSchema,
  mediaAssetParamsSchema,
  mediaAssetSchema,
  mediaUploadRequestSchema,
  mediaUploadResponseSchema,
  type MediaUploadRequest,
} from "@ih/contracts";
import { z } from "zod";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { CATALOG_MANAGE_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { MediaService } from "./media.service";

class UploadDto extends createZodDto(mediaUploadRequestSchema) {}
class CompleteDto extends createZodDto(z.strictObject({})) {}
class AssetParamsDto extends createZodDto(mediaAssetParamsSchema) {
  declare assetId: string;
}

/**
 * Brand logo and category image uploads (parity G-A7, ADR 0091): the same quarantine, upload
 * policy and processing as product images, with no product. The editor then sets the processed
 * image on the brand or category; nothing here is public.
 */
@Controller({ path: "admin/catalogue-images", version: "1" })
export class CatalogueImagesController {
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

  @Post("uploads")
  @HttpCode(201)
  @RequirePermission("catalog.write", "media.upload")
  @Serialize(mediaUploadResponseSchema)
  async authorize(
    @Body() body: UploadDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.media.authorizeCatalogueImage(
      await this.mutation(request, reply),
      body as unknown as MediaUploadRequest,
    );
  }

  @Post(":assetId/complete")
  @HttpCode(200)
  @RequirePermission("catalog.write", "media.upload")
  @Serialize(mediaAssetSchema)
  async complete(
    @Param() params: AssetParamsDto,
    @Body() _body: CompleteDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.media.completeCatalogueImage(await this.mutation(request, reply), params.assetId);
  }

  @Get(":assetId")
  @RequirePermission("catalog.read")
  @Serialize(catalogueImageResponseSchema)
  read(
    @Param() params: AssetParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "private, no-store");
    return this.media.catalogueImage(request.staff!.userId, params.assetId);
  }
}
