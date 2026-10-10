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
} from "@nestjs/common";
import { isIP } from "node:net";
import {
  categoryCreateRequestSchema,
  categoryParamsSchema,
  categoryResponseSchema,
  categoriesQuerySchema,
  categoriesResponseSchema,
  categoryStateRequestSchema,
  categoryUpdateRequestSchema,
  type CategoryCreateRequest,
  type CategoriesQuery,
  type CategoryStateRequest,
  type CategoryUpdateRequest,
} from "@ih/contracts";
import { defineFieldPolicy } from "@ih/domain";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { CATALOG_MANAGE_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { CategoriesService } from "./categories.service";

class CreateDto extends createZodDto(categoryCreateRequestSchema) {}
class UpdateDto extends createZodDto(categoryUpdateRequestSchema) {}
class StateDto extends createZodDto(categoryStateRequestSchema) {}
class QueryDto extends createZodDto(categoriesQuerySchema) {}
class ParamsDto extends createZodDto(categoryParamsSchema) {
  declare id: string;
}

/** SEO fields are Owner-only (architecture §11): stripped for callers without `seo.write`. */
const CATEGORY_FIELDS = defineFieldPolicy({ seo: "seo.write" });
const CATEGORIES_FIELDS = defineFieldPolicy({ items: { seo: "seo.write" } });

/** Admin category management (step 43). Reached only through the admin origin's /api/v1/admin/*. */
@Controller({ path: "admin/categories", version: "1" })
export class CategoriesController {
  constructor(
    private readonly categories: CategoriesService,
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
  @Serialize(categoriesResponseSchema, CATEGORIES_FIELDS)
  list(
    @Query() query: QueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.categories.list(request.staff!.userId, query as unknown as CategoriesQuery);
  }

  @Get(":id")
  @RequirePermission("catalog.read")
  @Serialize(categoryResponseSchema, CATEGORY_FIELDS)
  read(
    @Param() params: ParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.categories.read(request.staff!.userId, params.id);
  }

  @Post()
  @HttpCode(201)
  @RequirePermission("catalog.write")
  @Serialize(categoryResponseSchema, CATEGORY_FIELDS)
  async create(
    @Body() body: CreateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.categories.create(
      await this.mutation(request, reply),
      body as unknown as CategoryCreateRequest,
    );
  }

  @Patch(":id")
  @RequirePermission("catalog.write")
  @Serialize(categoryResponseSchema, CATEGORY_FIELDS)
  async update(
    @Param() params: ParamsDto,
    @Body() body: UpdateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.categories.update(
      await this.mutation(request, reply),
      params.id,
      body as unknown as CategoryUpdateRequest,
    );
  }

  @Post(":id/trash")
  @HttpCode(200)
  @RequirePermission("catalog.trash")
  @Serialize(categoryResponseSchema, CATEGORY_FIELDS)
  async trash(
    @Param() params: ParamsDto,
    @Body() body: StateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.categories.trash(
      await this.mutation(request, reply),
      params.id,
      body as unknown as CategoryStateRequest,
    );
  }

  @Post(":id/restore")
  @HttpCode(200)
  @RequirePermission("catalog.trash")
  @Serialize(categoryResponseSchema, CATEGORY_FIELDS)
  async restore(
    @Param() params: ParamsDto,
    @Body() body: StateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.categories.restore(
      await this.mutation(request, reply),
      params.id,
      body as unknown as CategoryStateRequest,
    );
  }
}
