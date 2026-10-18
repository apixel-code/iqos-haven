import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseInterceptors,
} from "@nestjs/common";
import { CatalogueInvalidationInterceptor } from "../cache/catalogue-invalidation.interceptor";
import { isIP } from "node:net";
import {
  brandCreateRequestSchema,
  brandParamsSchema,
  brandResponseSchema,
  brandsQuerySchema,
  brandsResponseSchema,
  brandStateRequestSchema,
  brandUpdateRequestSchema,
  type BrandCreateRequest,
  type BrandsQuery,
  type BrandStateRequest,
  type BrandUpdateRequest,
  parentPurgeResponseSchema,
} from "@ih/contracts";
import { defineFieldPolicy } from "@ih/domain";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { CATALOG_MANAGE_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { BrandsService } from "./brands.service";

class CreateDto extends createZodDto(brandCreateRequestSchema) {}
class UpdateDto extends createZodDto(brandUpdateRequestSchema) {}
class StateDto extends createZodDto(brandStateRequestSchema) {}
class QueryDto extends createZodDto(brandsQuerySchema) {}
class ParamsDto extends createZodDto(brandParamsSchema) {
  declare id: string;
}

/** SEO fields are Owner-only (architecture §11): stripped for callers without `seo.write`. */
const BRAND_FIELDS = defineFieldPolicy({ seo: "seo.write" });
const BRANDS_FIELDS = defineFieldPolicy({ items: { seo: "seo.write" } });

/** Admin brand management (step 42). Reached only through the admin origin's /api/v1/admin/*. */
@UseInterceptors(CatalogueInvalidationInterceptor)
@Controller({ path: "admin/brands", version: "1" })
export class BrandsController {
  constructor(
    private readonly brands: BrandsService,
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

  @Get()
  @RequirePermission("catalog.read")
  @Serialize(brandsResponseSchema, BRANDS_FIELDS)
  list(
    @Query() query: QueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.brands.list(request.staff!.userId, query as unknown as BrandsQuery);
  }

  @Get(":id")
  @RequirePermission("catalog.read")
  @Serialize(brandResponseSchema, BRAND_FIELDS)
  read(
    @Param() params: ParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.brands.read(request.staff!.userId, params.id);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("catalog.write")
  @Serialize(brandResponseSchema, BRAND_FIELDS)
  async create(
    @Body() body: CreateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.brands.create(
      await this.mutation(request, reply),
      body as unknown as BrandCreateRequest,
    );
  }

  @Patch(":id")
  @RequirePermission("catalog.write")
  @Serialize(brandResponseSchema, BRAND_FIELDS)
  async update(
    @Param() params: ParamsDto,
    @Body() body: UpdateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.brands.update(
      await this.mutation(request, reply),
      params.id,
      body as unknown as BrandUpdateRequest,
    );
  }

  @Post(":id/trash")
  @HttpCode(200)
  @RequirePermission("catalog.trash")
  @Serialize(brandResponseSchema, BRAND_FIELDS)
  async trash(
    @Param() params: ParamsDto,
    @Body() body: StateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.brands.trash(
      await this.mutation(request, reply),
      params.id,
      body as unknown as BrandStateRequest,
    );
  }

  @Post(":id/restore")
  @HttpCode(200)
  @RequirePermission("catalog.trash")
  @Serialize(brandResponseSchema, BRAND_FIELDS)
  async restore(
    @Param() params: ParamsDto,
    @Body() body: StateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.brands.restore(
      await this.mutation(request, reply),
      params.id,
      body as unknown as BrandStateRequest,
    );
  }

  /** Owner-only: a trashed brand that no product uses, gone for good (parity G-A7). */
  @Post(":id/purge")
  @HttpCode(200)
  @RequirePermission("catalog.purge")
  @Serialize(parentPurgeResponseSchema)
  async purge(
    @Param() params: ParamsDto,
    @Body() body: StateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.brands.purge(
      await this.mutation(request, reply),
      params.id,
      body as unknown as BrandStateRequest,
    );
  }
}
