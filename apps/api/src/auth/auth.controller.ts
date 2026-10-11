import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import {
  loginRequestSchema,
  meResponseSchema,
  type LoginRequest,
  type MeResponse,
} from "@ih/contracts";
import { isIP } from "node:net";
import { ipNetwork } from "@ih/domain";
import { errorSummary } from "@ih/logger";
import type { FastifyReply } from "fastify";
import { createZodDto } from "../http/zod-validation.pipe";
import { Authenticated, Public, type AuthenticatedRequest } from "./access";
import { AuthService, InvalidCredentialsError, toMeResponse } from "./auth.service";
import { LOGIN_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";
import { Serialize } from "./serialize";
import { clearedSessionCookie, readSessionTokens, sessionCookie } from "./session-cookie";

class LoginDto extends createZodDto(loginRequestSchema) {}

/** Admin authentication. Reached only through the admin origin's /api/v1/auth/* (gateway). */
@Controller({ path: "auth", version: "1" })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly limits: RateLimitService,
  ) {}

  @Post("login")
  @Public()
  @HttpCode(200)
  async login(
    @Body() body: LoginDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MeResponse> {
    reply.header("Cache-Control", "no-store");
    // The gateway sets X-IH-Client-IP (browser copies are stripped) and Nest is reachable only
    // through it (architecture §3); anything that is not an IP address falls back to the peer.
    const header = request.headers["x-ih-client-ip"];
    const ip = typeof header === "string" && isIP(header) ? header : request.ip;
    // Bounded by the contract (320); never logged or stored, only keyed-hashed by the limiter.
    const input = body as unknown as LoginRequest;
    const identity = input.email.trim().toLowerCase();
    const network = ipNetwork(ip) ?? ip;
    const identityNetwork = `${identity}\0${network}`;
    await this.limits.enforce(LOGIN_POLICY, { ip, identity, identityNetwork }, request, reply);
    try {
      const { token, staff } = await this.auth.login(input, {
        ip,
        userAgent: request.headers["user-agent"],
      });
      // A new sign-in replaces, never reuses, whatever session the browser presented before.
      for (const previous of readSessionTokens(request.headers.cookie))
        await this.auth.logout(previous);
      reply.header("Set-Cookie", sessionCookie(token, staff.expiresAt));
      await this.limits.reset(LOGIN_POLICY, "identityNetwork", identityNetwork);
      await this.limits.reset(LOGIN_POLICY, "identity", identity);
      request.log.info({ staffId: staff.userId }, "staff signed in");
      return toMeResponse(staff);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        // Generic: never says whether the email exists, the account is inactive or the password is wrong.
        request.log.info({ reason: "invalid_credentials" }, "sign-in rejected");
        throw new UnauthorizedException();
      }
      request.log.error(errorSummary(error), "sign-in failed");
      throw error;
    }
  }

  /** Always succeeds and clears the cookie; revokes the presented session if there is one. */
  @Post("logout")
  @Public()
  @HttpCode(204)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    for (const token of readSessionTokens(request.headers.cookie)) await this.auth.logout(token);
    reply.header("Cache-Control", "no-store").header("Set-Cookie", clearedSessionCookie());
  }

  @Get("me")
  @Authenticated()
  @Serialize(meResponseSchema)
  me(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): MeResponse {
    reply.header("Cache-Control", "no-store");
    return toMeResponse(request.staff!);
  }
}
