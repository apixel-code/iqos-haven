import {
  ConflictException,
  Controller,
  ForbiddenException,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { isIP } from "node:net";
import { adminOrderParamsSchema, reviewLinkResponseSchema } from "@ih/contracts";
import {
  issueReviewLink,
  ReviewLinkConflictError,
  ReviewLinkForbiddenError,
  ReviewLinkNotFoundError,
  type Database,
} from "@ih/db";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { DATABASE } from "../infra/tokens";
import { REVIEW_LINK_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";

class ParamsDto extends createZodDto(adminOrderParamsSchema) {
  declare id: string;
}

/**
 * `POST /v1/admin/orders/:id/review-link` (roadmap step 93, ADR 0061): a verified-purchase
 * review link for a Delivered order, shown once, with a WhatsApp message for staff to send
 * themselves. A new link revokes the previous one.
 */
@Controller({ path: "admin/orders", version: "1" })
export class ReviewLinkController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly limits: RateLimitService,
  ) {}

  @Post(":id/review-link")
  @HttpCode(201)
  @RequirePermission("orders.read", "customers.read")
  @Serialize(reviewLinkResponseSchema)
  async issue(
    @Param() params: ParamsDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // The answer holds a live credential: never cached, never logged.
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      REVIEW_LINK_POLICY,
      {
        ip: typeof header === "string" && isIP(header) ? header : request.ip,
        actor: request.staff!.userId,
      },
      request,
      reply,
    );
    try {
      return await issueReviewLink(
        this.db,
        { requestId: request.id, actorId: request.staff!.userId },
        params.id,
      );
    } catch (error) {
      if (error instanceof ReviewLinkForbiddenError) throw new ForbiddenException();
      if (error instanceof ReviewLinkNotFoundError) throw new NotFoundException();
      if (error instanceof ReviewLinkConflictError)
        throw new ConflictException({ code: error.reason });
      throw error;
    }
  }
}
