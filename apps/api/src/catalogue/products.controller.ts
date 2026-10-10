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
  productCreateRequestSchema,
  productParamsSchema,
  productResponseSchema,
  productsQuerySchema,
  productsResponseSchema,
  productUpdateRequestSchema,
  type ProductCreateRequest,
  type ProductsQuery,
  type ProductUpdateRequest,
} from "@ih/contracts";
import { defineFieldPolicy } from "@ih/domain";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { CATALOG_MANAGE_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { ProductsService } from "./products.service";

/** Discriminated unions are validated whole; the DTO only carries the contract. */
class CreateDto {
  static readonly schema = productCreateRequestSchema;
}
class UpdateDto {
  static readonly schema = productUpdateRequestSchema;
}
class QueryDto extends createZodDto(productsQuerySchema) {}
class ParamsDto extends createZodDto(productParamsSchema) {
  declare id: string;
}

/** SEO fields are Owner-only (architecture §11): stripped for callers without `seo.write`. */
const PRODUCT_FIELDS = defineFieldPolicy({ seo: "seo.write" });

/** Admin product create/edit/detail/list (step 44). Publication and trash are step 51. */
@UseInterceptors(CatalogueInvalidationInterceptor)
@Controller({ path: "admin/products", version: "1" })
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
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
  @Serialize(productsResponseSchema)
  list(
    @Query() query: QueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.products.list(request.staff!.userId, query as unknown as ProductsQuery);
  }

  @Get(":id")
  @RequirePermission("catalog.read")
  @Serialize(productResponseSchema, PRODUCT_FIELDS)
  read(
    @Param() params: ParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.products.read(request.staff!.userId, params.id);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("catalog.write")
  @Serialize(productResponseSchema, PRODUCT_FIELDS)
  async create(
    @Body() body: CreateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.products.create(
      await this.mutation(request, reply),
      body as unknown as ProductCreateRequest,
    );
  }

  @Patch(":id")
  @RequirePermission("catalog.write")
  @Serialize(productResponseSchema, PRODUCT_FIELDS)
  async update(
    @Param() params: ParamsDto,
    @Body() body: UpdateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.products.update(
      await this.mutation(request, reply),
      params.id,
      body as unknown as ProductUpdateRequest,
    );
  }
}
