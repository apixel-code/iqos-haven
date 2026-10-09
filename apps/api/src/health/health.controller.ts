import { Controller, Get, HttpCode, Res } from "@nestjs/common";
import type { LivenessResponse, ReadinessResponse } from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { Public } from "../auth/access";
import { HealthService } from "./health.service";
/** Internal orchestrator endpoints. The gateway must deny public production access. */
@Controller({ path: "health", version: "1" })
export class HealthController {
  constructor(private readonly health: HealthService) {}
  @Get("live")
  @Public()
  @HttpCode(200)
  live(): LivenessResponse {
    return { status: "ok" };
  }
  @Get("ready")
  @Public()
  async ready(@Res({ passthrough: true }) res: FastifyReply): Promise<ReadinessResponse> {
    const result = await this.health.readiness();
    res.status(result.status === "down" ? 503 : 200).header("Cache-Control", "no-store");
    return result;
  }
}
