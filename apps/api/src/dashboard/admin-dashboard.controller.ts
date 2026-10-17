import { Controller, ForbiddenException, Get, Inject, Req, Res } from "@nestjs/common";
import { adminDashboardSchema } from "@ih/contracts";
import { DashboardForbiddenError, readAdminDashboard, type Database } from "@ih/db";
import type { FastifyReply } from "fastify";
import { Authenticated, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { DATABASE } from "../infra/tokens";

/**
 * `GET /v1/admin/dashboard` (roadmap step 108, ADR 0074): the operational home for any signed-in
 * staff member. The sections are decided per caller by the database read, from the rights held
 * now: what a Staff role may not see is `null`, never hidden by the UI alone.
 */
@Controller({ path: "admin/dashboard", version: "1" })
export class AdminDashboardController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  @Authenticated()
  @Serialize(adminDashboardSchema)
  async read(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Cookie");
    try {
      return await readAdminDashboard(this.db, request.staff!.userId);
    } catch (error) {
      if (error instanceof DashboardForbiddenError) throw new ForbiddenException();
      throw error;
    }
  }
}
