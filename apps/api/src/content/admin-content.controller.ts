import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseInterceptors,
} from "@nestjs/common";
import { isIP } from "node:net";
import { z } from "zod";
import {
  adminContentResponseSchema,
  adminContentSectionSchema,
  contentDraftRequestSchema,
  contentImagesResponseSchema,
  contentKeyParamsSchema,
  contentPreviewResponseSchema,
  contentPublishRequestSchema,
  mediaAssetParamsSchema,
  mediaAssetSchema,
  mediaUploadRequestSchema,
  mediaUploadResponseSchema,
  type ContentSectionKey,
  type MediaUploadRequest,
} from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { CatalogueInvalidationInterceptor } from "../cache/catalogue-invalidation.interceptor";
import { createZodDto } from "../http/zod-validation.pipe";
import { CONTENT_MANAGE_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { ContentService } from "./content.service";

class KeyDto extends createZodDto(contentKeyParamsSchema) {
  declare key: ContentSectionKey;
}
class DraftDto extends createZodDto(contentDraftRequestSchema) {
  declare expectedVersion: number;
  declare content: Record<string, unknown>;
}
class PublishDto extends createZodDto(contentPublishRequestSchema) {
  declare expectedVersion: number;
}
class UploadDto extends createZodDto(mediaUploadRequestSchema) {}
class CompleteDto extends createZodDto(z.strictObject({})) {}
class AssetDto extends createZodDto(mediaAssetParamsSchema) {
  declare assetId: string;
}

/**
 * Storefront content editor API (roadmap step 97, ADR 0065). `content.manage` (Owner only).
 * Drafts are saved and published separately, each at the version the editor loaded; nothing
 * a draft holds is public until it is published. The preview is admin-only.
 */
@UseInterceptors(CatalogueInvalidationInterceptor)
@Controller({ path: "admin/content", version: "1" })
@RequirePermission("content.manage")
export class AdminContentController {
  constructor(
    private readonly content: ContentService,
    private readonly limits: RateLimitService,
  ) {}

  private read(reply: FastifyReply) {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");
  }
  private async mutation(request: AuthenticatedRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      CONTENT_MANAGE_POLICY,
      {
        ip: typeof header === "string" && isIP(header) ? header : request.ip,
        actor: request.staff!.userId,
      },
      request,
      reply,
    );
    return { requestId: request.id, actorId: request.staff!.userId };
  }

  @Get()
  @Serialize(adminContentResponseSchema)
  list(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    this.read(reply);
    return this.content.sections(request.staff!.userId);
  }

  @Get("images")
  @Serialize(contentImagesResponseSchema)
  images(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    this.read(reply);
    return this.content.images(request.staff!.userId);
  }

  @Post("images/uploads")
  @HttpCode(201)
  @Serialize(mediaUploadResponseSchema)
  async authorizeImage(
    @Body() body: UploadDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.content.authorizeImage(
      await this.mutation(request, reply),
      body as unknown as MediaUploadRequest,
    );
  }

  @Post("images/:assetId/complete")
  @HttpCode(200)
  @Serialize(mediaAssetSchema)
  async completeImage(
    @Param() params: AssetDto,
    @Body() _body: CompleteDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.content.completeImage(await this.mutation(request, reply), params.assetId);
  }

  @Get(":key/preview")
  @Serialize(contentPreviewResponseSchema)
  preview(
    @Param() params: KeyDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    this.read(reply);
    return this.content.preview(request.staff!.userId, params.key);
  }

  @Put(":key/draft")
  @HttpCode(200)
  @Serialize(adminContentSectionSchema)
  async saveDraft(
    @Param() params: KeyDto,
    @Body() body: DraftDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.content.saveDraft(
      await this.mutation(request, reply),
      params.key,
      body.expectedVersion,
      body.content,
    );
  }

  @Post(":key/publish")
  @HttpCode(200)
  @Serialize(adminContentSectionSchema)
  async publish(
    @Param() params: KeyDto,
    @Body() body: PublishDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.content.publish(
      await this.mutation(request, reply),
      params.key,
      body.expectedVersion,
    );
  }
}
