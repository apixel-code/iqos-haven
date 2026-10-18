import { Controller, Get, Res } from "@nestjs/common";
import type { InternalOpsResponse } from "@ih/contracts";
import type { FastifyReply } from "fastify";
import { InternalService } from "../internal/service-auth.guard";
import { HealthService } from "./health.service";
import { OpsCounters } from "./ops-counters";

/**
 * The worker's ops monitor reads the API's own signals here (roadmap step 125): checkout and
 * quote server errors over the last ten minutes, and readiness. HMAC service auth; the gateway
 * never routes `/v1/internal`. Counts only.
 */
@Controller({ path: "internal/ops", version: "1" })
export class OpsController {
  constructor(
    private readonly health: HealthService,
    private readonly counters: OpsCounters,
  ) {}

  @Get()
  @InternalService("worker")
  async ops(@Res({ passthrough: true }) reply: FastifyReply): Promise<InternalOpsResponse> {
    reply.header("Cache-Control", "no-store");
    return { checkout: this.counters.snapshot(), readiness: await this.health.readiness() };
  }
}
