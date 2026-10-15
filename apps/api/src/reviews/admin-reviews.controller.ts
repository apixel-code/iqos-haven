import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseInterceptors,
} from "@nestjs/common";
import {
  adminReviewParamsSchema,
  adminReviewsQuerySchema,
  adminReviewsResponseSchema,
  reviewModerationRequestSchema,
  reviewModerationResponseSchema,
  type AdminReviewsQuery,
  type ReviewModerationRequest,
} from "@ih/contracts";
import {
  listAdminReviews,
  moderateReview,
  ReviewCursorError,
  ReviewModerationConflictError,
  ReviewModerationForbiddenError,
  ReviewNotFoundError,
  type Database,
} from "@ih/db";
import type { FastifyReply } from "fastify";
import { isIP } from "node:net";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { CatalogueInvalidationInterceptor } from "../cache/catalogue-invalidation.interceptor";
import { createZodDto } from "../http/zod-validation.pipe";
import { DATABASE } from "../infra/tokens";
import { REVIEW_MODERATION_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";

class ParamsDto extends createZodDto(adminReviewParamsSchema) {
  declare id: string;
}
class QueryDto extends createZodDto(adminReviewsQuerySchema) {}
class ModerationDto extends createZodDto(reviewModerationRequestSchema) {
  declare decision: ReviewModerationRequest["decision"];
  declare expectedVersion: number;
}

async function run<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ReviewModerationForbiddenError) throw new ForbiddenException();
    if (error instanceof ReviewNotFoundError) throw new NotFoundException();
    if (error instanceof ReviewCursorError) throw new BadRequestException();
    if (error instanceof ReviewModerationConflictError)
      throw new ConflictException({ code: error.reason });
    throw error;
  }
}

/**
 * Review moderation (roadmap step 95, ADR 0063). `reviews.moderate` (Owner at launch). A
 * decision names the version it was made on; the product page cache drops after it commits
 * here, and on every replica through the `catalog.changed` event.
 */
@UseInterceptors(CatalogueInvalidationInterceptor)
@Controller({ path: "admin/reviews", version: "1" })
@RequirePermission("reviews.moderate")
export class AdminReviewsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly limits: RateLimitService,
  ) {}

  @Get()
  @Serialize(adminReviewsResponseSchema)
  list(
    @Query() query: QueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");
    return run(() =>
      listAdminReviews(this.db, request.staff!.userId, query as unknown as AdminReviewsQuery),
    );
  }

  @Post(":id/moderation")
  @HttpCode(200)
  @Serialize(reviewModerationResponseSchema)
  async moderate(
    @Param() params: ParamsDto,
    @Body() body: ModerationDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      REVIEW_MODERATION_POLICY,
      {
        ip: typeof header === "string" && isIP(header) ? header : request.ip,
        actor: request.staff!.userId,
      },
      request,
      reply,
    );
    return run(() =>
      moderateReview(
        this.db,
        { requestId: request.id, actorId: request.staff!.userId },
        params.id,
        body as ReviewModerationRequest,
      ),
    );
  }
}
