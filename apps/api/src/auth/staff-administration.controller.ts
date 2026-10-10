import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import {
  staffListQuerySchema,
  staffIdParamsSchema,
  staffEditRequestSchema,
  staffDeactivateRequestSchema,
  staffResponseSchema,
  staffListResponseSchema,
} from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { isIP } from "node:net";
import { createZodDto } from "../http/zod-validation.pipe";
import { RequirePermission, type AuthenticatedRequest } from "./access";
import { Serialize, NoResponseBody } from "./serialize";
import { clearedSessionCookie } from "./session-cookie";
import { StaffAdministrationService } from "./staff-administration.service";
import { RateLimitService } from "../security/rate-limit.service";
import { STAFF_MANAGE_POLICY } from "../security/limit-policies";
class StaffQuery extends createZodDto(staffListQuerySchema) {
  declare limit: number;
  declare after?: string;
}
class StaffParams extends createZodDto(staffIdParamsSchema) {
  declare id: string;
}
class StaffEditDto extends createZodDto(staffEditRequestSchema) {
  declare version: number;
  declare name?: string;
  declare email?: string;
}
class StaffDeactivateDto extends createZodDto(staffDeactivateRequestSchema) {
  declare version: number;
}
@RequirePermission("staff.manage")
@Controller({ path: "admin/staff", version: "1" })
export class StaffController {
  constructor(
    private readonly staff: StaffAdministrationService,
    private readonly limits: RateLimitService,
  ) {}
  @Get()
  @Serialize(staffListResponseSchema)
  async list(
    @Query() query: StaffQuery,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.staff.list(request.staff!.userId, query);
  }
  @Patch(":id")
  @Serialize(staffResponseSchema)
  async edit(
    @Param() params: StaffParams,
    @Body() body: StaffEditDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.limit(request, reply);
    const row = await this.staff.edit(
      { requestId: request.id, actorId: request.staff!.userId },
      params.id,
      body,
    );
    if (
      row &&
      params.id.toLowerCase() === request.staff!.userId &&
      row.email !== request.staff!.email
    )
      reply.header("Set-Cookie", clearedSessionCookie());
    return row;
  }
  @Post(":id/deactivate")
  @NoResponseBody()
  async deactivate(
    @Param() params: StaffParams,
    @Body() body: StaffDeactivateDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.limit(request, reply);
    await this.staff.deactivate(
      { requestId: request.id, actorId: request.staff!.userId },
      params.id,
      body.version,
    );
    if (params.id.toLowerCase() === request.staff!.userId)
      reply.header("Set-Cookie", clearedSessionCookie());
  }
  private async limit(request: AuthenticatedRequest, reply: FastifyReply) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    const ip = typeof header === "string" && isIP(header) ? header : request.ip;
    await this.limits.enforce(
      STAFF_MANAGE_POLICY,
      { ip, actor: request.staff!.userId },
      request,
      reply,
    );
  }
}
