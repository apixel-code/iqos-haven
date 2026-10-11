import { Body, Controller, HttpCode, Post, Req, Res, BadRequestException } from "@nestjs/common";
import { forgotRequestSchema, forgotResponseSchema, resetRequestSchema } from "@ih/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { createZodDto } from "../http/zod-validation.pipe";
import { Public } from "./access";
import { Serialize, NoResponseBody } from "./serialize";
import { clearedSessionCookie } from "./session-cookie";
import { PasswordResetService } from "./password-reset.service";
import { RateLimitService } from "../security/rate-limit.service";
import { RESET_REQUEST_POLICY, RESET_CONSUME_POLICY } from "../security/limit-policies";

class ForgotDto extends createZodDto(forgotRequestSchema) {
  declare email: string;
}
class ResetDto extends createZodDto(resetRequestSchema) {
  declare token: string;
  declare password: string;
}
function clientIp(request: FastifyRequest): string {
  const header = request.headers["x-ih-client-ip"];
  return typeof header === "string" && isIP(header) ? header : request.ip;
}
@Controller({ path: "auth", version: "1" })
export class PasswordResetController {
  constructor(
    private readonly resets: PasswordResetService,
    private readonly limits: RateLimitService,
  ) {}
  @Post("forgot")
  @Public()
  @HttpCode(200)
  @Serialize(forgotResponseSchema)
  async forgot(
    @Body() body: ForgotDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ accepted: true }> {
    reply.header("Cache-Control", "no-store");
    await this.limits.enforce(
      RESET_REQUEST_POLICY,
      {
        ip: clientIp(request),
        identity: body.email.trim().toLowerCase(),
      },
      request,
      reply,
    );
    await this.resets.request(body.email, request.id);
    return { accepted: true };
  }
  @Post("reset")
  @Public()
  @NoResponseBody()
  async reset(
    @Body() body: ResetDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    reply.header("Cache-Control", "no-store");
    await this.limits.enforce(RESET_CONSUME_POLICY, { ip: clientIp(request) }, request, reply);
    // Generic for malformed/expired/reused/inactive links and rejected passwords.
    if (!(await this.resets.consume(body.token, body.password, request.id)))
      throw new BadRequestException();
    reply.header("Set-Cookie", clearedSessionCookie());
  }
}
