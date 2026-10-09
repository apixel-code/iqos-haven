import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { loginRequestSchema, type MeResponse } from "@ih/contracts";
import { errorSummary } from "@ih/logger";
import type { FastifyReply } from "fastify";
import { createZodDto } from "../http/zod-validation.pipe";
import { AuthGuard, type AuthenticatedRequest } from "./auth.guard";
import { AuthService, InvalidCredentialsError, toMeResponse } from "./auth.service";
import { clearedSessionCookie, readSessionTokens, sessionCookie } from "./session-cookie";

class LoginDto extends createZodDto(loginRequestSchema) {}

/** Admin authentication. Reached only through the admin origin's /api/v1/auth/* (gateway). */
@Controller({ path: "auth", version: "1" })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("login")
  @HttpCode(200)
  async login(
    @Body() body: LoginDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<MeResponse> {
    reply.header("Cache-Control", "no-store");
    try {
      const ip = request.headers["x-ih-client-ip"];
      const { token, staff } = await this.auth.login(body as { email: string; password: string }, {
        ip: typeof ip === "string" ? ip : undefined,
        userAgent: request.headers["user-agent"],
      });
      // A new sign-in replaces, never reuses, whatever session the browser presented before.
      for (const previous of readSessionTokens(request.headers.cookie))
        await this.auth.logout(previous);
      reply.header("Set-Cookie", sessionCookie(token, staff.expiresAt));
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
  @HttpCode(204)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    for (const token of readSessionTokens(request.headers.cookie)) await this.auth.logout(token);
    reply.header("Cache-Control", "no-store").header("Set-Cookie", clearedSessionCookie());
  }

  @Get("me")
  @UseGuards(AuthGuard)
  me(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): MeResponse {
    reply.header("Cache-Control", "no-store");
    return toMeResponse(request.staff!);
  }
}
