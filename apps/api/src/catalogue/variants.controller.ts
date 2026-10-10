import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Req, Res } from "@nestjs/common";
import { isIP } from "node:net";
import {
  productParamsSchema,
  productOptionsWriteRequestSchema,
  productVariantParamsSchema,
  productVariantsResponseSchema,
  variantCreateRequestSchema,
  variantUpdateRequestSchema,
  type ProductOptionsWriteRequest,
  type VariantCreateRequest,
  type VariantUpdateRequest,
} from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { CATALOG_MANAGE_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { VariantsService } from "./variants.service";

class OptionsDto extends createZodDto(productOptionsWriteRequestSchema) {}
class CreateDto extends createZodDto(variantCreateRequestSchema) {}
class UpdateDto extends createZodDto(variantUpdateRequestSchema) {}
class ProductParamsDto extends createZodDto(productParamsSchema) {
  declare id: string;
}
class VariantParamsDto extends createZodDto(productVariantParamsSchema) {
  declare id: string;
  declare variantId: string;
}

/**
 * Product options and variants (step 45). Every response is the product's full option/variant
 * snapshot so the editor never mixes versions. Stock is read-only here (ledger, steps 46–47).
 */
@Controller({ path: "admin/products", version: "1" })
export class VariantsController {
  constructor(
    private readonly variants: VariantsService,
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

  @Get(":id/variants")
  @RequirePermission("catalog.read")
  @Serialize(productVariantsResponseSchema)
  read(
    @Param() params: ProductParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.variants.read(request.staff!.userId, params.id);
  }

  @Put(":id/options")
  @RequirePermission("catalog.write")
  @Serialize(productVariantsResponseSchema)
  async options(
    @Param() params: ProductParamsDto,
    @Body() body: OptionsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.variants.options(
      await this.mutation(request, reply),
      params.id,
      body as unknown as ProductOptionsWriteRequest,
    );
  }

  @Post(":id/variants")
  @HttpCode(201)
  @RequirePermission("catalog.write")
  @Serialize(productVariantsResponseSchema)
  async create(
    @Param() params: ProductParamsDto,
    @Body() body: CreateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.variants.create(
      await this.mutation(request, reply),
      params.id,
      body as unknown as VariantCreateRequest,
    );
  }

  @Patch(":id/variants/:variantId")
  @RequirePermission("catalog.write")
  @Serialize(productVariantsResponseSchema)
  async update(
    @Param() params: VariantParamsDto,
    @Body() body: UpdateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.variants.update(
      await this.mutation(request, reply),
      params.id,
      params.variantId,
      body as unknown as VariantUpdateRequest,
    );
  }
}
