import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseInterceptors,
} from "@nestjs/common";
import { CatalogueInvalidationInterceptor } from "../cache/catalogue-invalidation.interceptor";
import { isIP } from "node:net";
import {
  galleryAttachRequestSchema,
  galleryImageParamsSchema,
  galleryRemoveRequestSchema,
  galleryReorderRequestSchema,
  galleryUpdateRequestSchema,
  productGalleryResponseSchema,
  productParamsSchema,
  type GalleryAttachRequest,
  type GalleryReorderRequest,
  type GalleryUpdateRequest,
} from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { CATALOG_MANAGE_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { GalleryService } from "./gallery.service";

class AttachDto extends createZodDto(galleryAttachRequestSchema) {}
class UpdateDto extends createZodDto(galleryUpdateRequestSchema) {}
class ReorderDto extends createZodDto(galleryReorderRequestSchema) {}
class RemoveDto extends createZodDto(galleryRemoveRequestSchema) {
  declare version: number;
}
class ProductParamsDto extends createZodDto(productParamsSchema) {
  declare id: string;
}
class ImageParamsDto extends createZodDto(galleryImageParamsSchema) {
  declare id: string;
  declare imageId: string;
}

/** Product image gallery (step 50). Every response is the full gallery snapshot. */
@UseInterceptors(CatalogueInvalidationInterceptor)
@Controller({ path: "admin/products", version: "1" })
export class GalleryController {
  constructor(
    private readonly gallery: GalleryService,
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

  @Get(":id/images")
  @RequirePermission("catalog.read")
  @Serialize(productGalleryResponseSchema)
  read(
    @Param() params: ProductParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.gallery.read(request.staff!.userId, params.id);
  }

  @Post(":id/images")
  @HttpCode(201)
  @RequirePermission("catalog.write")
  @Serialize(productGalleryResponseSchema)
  async attach(
    @Param() params: ProductParamsDto,
    @Body() body: AttachDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.gallery.attach(
      await this.mutation(request, reply),
      params.id,
      body as unknown as GalleryAttachRequest,
    );
  }

  @Put(":id/images/order")
  @RequirePermission("catalog.write")
  @Serialize(productGalleryResponseSchema)
  async reorder(
    @Param() params: ProductParamsDto,
    @Body() body: ReorderDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.gallery.reorder(
      await this.mutation(request, reply),
      params.id,
      body as unknown as GalleryReorderRequest,
    );
  }

  @Patch(":id/images/:imageId")
  @RequirePermission("catalog.write")
  @Serialize(productGalleryResponseSchema)
  async update(
    @Param() params: ImageParamsDto,
    @Body() body: UpdateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.gallery.update(
      await this.mutation(request, reply),
      params.id,
      params.imageId,
      body as unknown as GalleryUpdateRequest,
    );
  }

  @Post(":id/images/:imageId/remove")
  @HttpCode(200)
  @RequirePermission("catalog.write")
  @Serialize(productGalleryResponseSchema)
  async remove(
    @Param() params: ImageParamsDto,
    @Body() body: RemoveDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.gallery.remove(
      await this.mutation(request, reply),
      params.id,
      params.imageId,
      body.version,
    );
  }
}
