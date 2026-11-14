import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, Res } from "@nestjs/common";
import {
  guideCreateRequestSchema,
  guideParamsSchema,
  guideResponseSchema,
  guidesResponseSchema,
  guideUpdateRequestSchema,
  storeGuideParamsSchema,
  storeGuideResponseSchema,
  storeGuidesResponseSchema,
  type GuideCreateRequest,
  type GuideUpdateRequest,
} from "@ih/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { AgeVerified, RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { CONTENT_MANAGE_POLICY, storeCatalogPolicy } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { GuidesService } from "./guides.service";

class CreateDto extends createZodDto(guideCreateRequestSchema) {
  declare slug: GuideCreateRequest["slug"];
}
class UpdateDto extends createZodDto(guideUpdateRequestSchema) {
  declare version: GuideUpdateRequest["version"];
}
class ParamsDto extends createZodDto(guideParamsSchema) {
  declare id: string;
}
class StoreParamsDto extends createZodDto(storeGuideParamsSchema) {
  declare slug: string;
}

const clientIp = (request: FastifyRequest) => {
  const header = request.headers["x-ih-client-ip"];
  return typeof header === "string" && isIP(header) ? header : request.ip;
};

/** Guides administration (ADR 0117). `content.manage` (Owner only); nothing is deleted. */
@Controller({ path: "admin/guides", version: "1" })
@RequirePermission("content.manage")
export class AdminGuidesController {
  constructor(
    private readonly guides: GuidesService,
    private readonly limits: RateLimitService,
  ) {}
  private async mutation(request: AuthenticatedRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    await this.limits.enforce(
      CONTENT_MANAGE_POLICY,
      { ip: clientIp(request), actor: request.staff!.userId },
      request,
      reply,
    );
    return { requestId: request.id, actorId: request.staff!.userId };
  }
  @Get()
  @Serialize(guidesResponseSchema)
  list(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    return this.guides.list(request.staff!.userId);
  }
  @Get(":id")
  @Serialize(guideResponseSchema)
  read(
    @Param() params: ParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.guides.read(request.staff!.userId, params.id);
  }
  @Post()
  @HttpCode(201)
  @Serialize(guideResponseSchema)
  async create(
    @Body() body: CreateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.guides.create(await this.mutation(request, reply), body as GuideCreateRequest);
  }
  @Patch(":id")
  @Serialize(guideResponseSchema)
  async update(
    @Param() params: ParamsDto,
    @Body() body: UpdateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.guides.update(
      await this.mutation(request, reply),
      params.id,
      body as GuideUpdateRequest,
    );
  }
}

/**
 * Store reads of guides (ADR 0117): behind the age ticket like the catalogue, limited per
 * address under the catalogue read budget, never cached by a browser or proxy.
 */
@Controller({ path: "store/guides", version: "1" })
export class StoreGuidesController {
  constructor(
    private readonly guides: GuidesService,
    private readonly limits: RateLimitService,
  ) {}
  private async guard(request: FastifyRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");
    await this.limits.enforce(
      storeCatalogPolicy(request),
      { ip: clientIp(request) },
      request,
      reply,
    );
  }
  @Get()
  @AgeVerified()
  @Serialize(storeGuidesResponseSchema)
  async list(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.guard(request, reply);
    return this.guides.storeList();
  }
  @Get(":slug")
  @AgeVerified()
  @Serialize(storeGuideResponseSchema)
  async read(
    @Param() params: StoreParamsDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.guard(request, reply);
    return this.guides.storeRead(params.slug);
  }
}
