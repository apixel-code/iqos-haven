import {
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Put,
  Req,
  Res,
} from "@nestjs/common";
import {
  publicSeoPolicySchema,
  seoIssuesResponseSchema,
  seoOverviewSchema,
  seoPolicyWriteRequestSchema,
  type SeoPolicyWriteRequest,
} from "@ih/contracts";
import {
  readPublicSeoPolicy,
  readSeoIssues,
  readSeoOverview,
  SeoConflictError,
  SeoForbiddenError,
  writeSeoPolicy,
  type Database,
} from "@ih/db";
import type { FastifyReply } from "fastify";
import { Public, RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { DATABASE } from "../infra/tokens";

class PolicyDto extends createZodDto(seoPolicyWriteRequestSchema) {}

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SeoForbiddenError) throw new ForbiddenException();
    if (error instanceof SeoConflictError)
      throw new ConflictException({ code: "VERSION_CONFLICT" });
    throw error;
  }
}
const privateAnswer = (reply: FastifyReply) =>
  reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");

/**
 * The Owner's SEO tools (roadmap step 113, ADR 0079): the indexing policy and which SEO
 * features are really active (`seo.write`), and the issue report (`seo.reports`). The SEO fields
 * themselves are edited on each product, brand and category (step 42–44, Owner-only).
 */
@Controller({ path: "admin/seo", version: "1" })
export class AdminSeoController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  @RequirePermission("seo.write")
  @Serialize(seoOverviewSchema)
  overview(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    privateAnswer(reply);
    return run(() => readSeoOverview(this.db, request.staff!.userId));
  }

  @Put("policy")
  @RequirePermission("seo.write")
  @Serialize(seoOverviewSchema)
  policy(
    @Body() body: PolicyDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    privateAnswer(reply);
    return run(() =>
      writeSeoPolicy(
        this.db,
        { requestId: request.id, actorId: request.staff!.userId },
        body as unknown as SeoPolicyWriteRequest,
      ),
    );
  }

  @Get("issues")
  @RequirePermission("seo.reports")
  @Serialize(seoIssuesResponseSchema)
  issues(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    privateAnswer(reply);
    return run(() => readSeoIssues(this.db, request.staff!.userId));
  }
}

/**
 * `GET /v1/public/seo` (step 113): the indexing policy only, for the storefront's robots.txt,
 * sitemap and policy pages, which are served without an age ticket. It holds no catalogue
 * data. Kept briefly in shared caches: a change shows within a minute.
 */
@Controller({ path: "public/seo", version: "1" })
export class PublicSeoController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  @Public()
  @HttpCode(200)
  async read(@Res({ passthrough: true }) reply: FastifyReply) {
    reply.header("Cache-Control", "public, max-age=60");
    return publicSeoPolicySchema.parse(await readPublicSeoPolicy(this.db));
  }
}
