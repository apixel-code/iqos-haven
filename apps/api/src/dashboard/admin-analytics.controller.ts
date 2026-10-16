import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { analyticsQuerySchema, analyticsSchema, type AnalyticsQuery } from "@ih/contracts";
import { FinancialReadForbiddenError, readAnalytics, type Database } from "@ih/db";
import { MetricRangeError } from "@ih/domain";
import type { FastifyReply } from "fastify";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { createZodDto } from "../http/zod-validation.pipe";
import { DATABASE } from "../infra/tokens";

class QueryDto extends createZodDto(analyticsQuerySchema) {}

/**
 * `GET /v1/admin/analytics?from&to` (roadmap step 109, ADR 0075): the Owner's sales, product,
 * brand, search and saved-list analytics for Dubai days, from the daily tables with their
 * freshness. `dashboard.financial_read`, checked again inside the read.
 */
@Controller({ path: "admin/analytics", version: "1" })
@RequirePermission("dashboard.financial_read")
export class AdminAnalyticsController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  @Serialize(analyticsSchema)
  async read(
    @Query() query: QueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");
    try {
      return await readAnalytics(
        this.db,
        request.staff!.userId,
        query as unknown as AnalyticsQuery,
      );
    } catch (error) {
      if (error instanceof FinancialReadForbiddenError) throw new ForbiddenException();
      if (error instanceof MetricRangeError) throw new BadRequestException();
      throw error;
    }
  }
}
