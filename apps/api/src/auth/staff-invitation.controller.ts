import { Body, Controller, Post, Req, Res, BadRequestException } from "@nestjs/common";
import {
  invitationRequestSchema,
  invitationResponseSchema,
  invitationRevokeRequestSchema,
  invitationAcceptRequestSchema,
} from "@ih/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import type { RoleKey } from "@ih/domain";
import { createZodDto } from "../http/zod-validation.pipe";
import { Public, RequirePermission, type AuthenticatedRequest } from "./access";
import { Serialize, NoResponseBody } from "./serialize";
import { StaffInvitationService } from "./staff-invitation.service";
import { RateLimitService } from "../security/rate-limit.service";
import { INVITATION_MANAGE_POLICY, INVITATION_ACCEPT_POLICY } from "../security/limit-policies";
class InviteDto extends createZodDto(invitationRequestSchema) {
  declare email: string;
  declare name: string;
  declare role: RoleKey;
}
class RevokeDto extends createZodDto(invitationRevokeRequestSchema) {
  declare invitationId: string;
}
class AcceptDto extends createZodDto(invitationAcceptRequestSchema) {
  declare token: string;
  declare password: string;
}
function clientIp(request: FastifyRequest) {
  const header = request.headers["x-ih-client-ip"];
  return typeof header === "string" && isIP(header) ? header : request.ip;
}
@Controller({ path: "admin/staff/invitations", version: "1" })
export class StaffInvitationController {
  constructor(
    private readonly invites: StaffInvitationService,
    private readonly limits: RateLimitService,
  ) {}
  @Post()
  @RequirePermission("staff.manage")
  @Serialize(invitationResponseSchema)
  async issue(
    @Body() body: InviteDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    await this.limits.enforce(
      INVITATION_MANAGE_POLICY,
      { ip: clientIp(request), actor: request.staff!.userId },
      request,
      reply,
    );
    return this.invites.issue({ requestId: request.id, actorId: request.staff!.userId }, body);
  }
  @Post("revoke")
  @RequirePermission("staff.manage")
  @NoResponseBody()
  async revoke(
    @Body() body: RevokeDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    await this.limits.enforce(
      INVITATION_MANAGE_POLICY,
      { ip: clientIp(request), actor: request.staff!.userId },
      request,
      reply,
    );
    await this.invites.revoke(
      { requestId: request.id, actorId: request.staff!.userId },
      body.invitationId,
    );
  }
}
@Controller({ path: "auth/invite", version: "1" })
export class StaffInvitationAcceptController {
  constructor(
    private readonly invites: StaffInvitationService,
    private readonly limits: RateLimitService,
  ) {}
  @Post("accept")
  @Public()
  @NoResponseBody()
  async accept(
    @Body() body: AcceptDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    await this.limits.enforce(INVITATION_ACCEPT_POLICY, { ip: clientIp(request) }, request, reply);
    if (!(await this.invites.accept(body.token, body.password, request.id)))
      throw new BadRequestException();
  }
}
