import { Body, Controller, Get, Patch, Query, Req, Res } from "@nestjs/common";
import {
  settingsWriteRequestSchema,
  settingsQuerySchema,
  settingsResponseSchema,
  settingResponseSchema,
  type SettingsWriteRequest,
} from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { isIP } from "node:net";
import { createZodDto } from "../http/zod-validation.pipe";
import { RequirePermission, type AuthenticatedRequest } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { RateLimitService } from "../security/rate-limit.service";
import { SETTINGS_MANAGE_POLICY } from "../security/limit-policies";
import { SettingsService } from "./settings.service";
class WriteDto {
  static readonly schema = settingsWriteRequestSchema;
}
class QueryDto extends createZodDto(settingsQuerySchema) {}
@Controller({ path: "admin/settings", version: "1" })
@RequirePermission("settings.manage")
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly limits: RateLimitService,
  ) {}
  @Get()
  @Serialize(settingsResponseSchema)
  read(
    @Query() _query: QueryDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    return this.settings.read(request.staff!.userId);
  }
  @Patch()
  @Serialize(settingResponseSchema)
  async write(
    @Body() body: WriteDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header("Cache-Control", "no-store");
    const header = request.headers["x-ih-client-ip"];
    await this.limits.enforce(
      SETTINGS_MANAGE_POLICY,
      {
        ip: typeof header === "string" && isIP(header) ? header : request.ip,
        actor: request.staff!.userId,
      },
      request,
      reply,
    );
    return this.settings.write(
      { requestId: request.id, actorId: request.staff!.userId },
      body as unknown as SettingsWriteRequest,
    );
  }
}
