import { Module } from "@nestjs/common";
import type { ApiEnv } from "@ih/config";
import { API_ENV } from "../infra/tokens";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { OpsController } from "./ops.controller";
import { OpsCounters } from "./ops-counters";

@Module({
  controllers: [HealthController, OpsController],
  providers: [
    HealthService,
    {
      provide: OpsCounters,
      inject: [API_ENV],
      useFactory: (env: ApiEnv) => new OpsCounters(env.CHECKOUT_SUBMISSION_ENABLED),
    },
  ],
  exports: [OpsCounters],
})
export class HealthModule {}
