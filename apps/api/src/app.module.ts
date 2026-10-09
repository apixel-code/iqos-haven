import { Module, type DynamicModule } from "@nestjs/common";
import type { ApiEnv } from "@ih/config";
import { loggerOptions } from "@ih/logger";
import { LoggerModule } from "nestjs-pino";
import { ReliabilityModule } from "./reliability/reliability.module";
import { HealthModule } from "./health/health.module";
import { InfraModule } from "./infra/infra.module";
import { InternalModule } from "./internal/internal.module";
import { requestId } from "./http/request-id";
@Module({})
export class AppModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            ...loggerOptions("api", env.LOG_LEVEL),
            genReqId: (req, res) => {
              const id = requestId(req);
              res.setHeader("x-request-id", id);
              return id;
            },
            serializers: {
              req: (req: { id: string; method: string }) => ({ id: req.id, method: req.method }),
            },
            autoLogging: {
              ignore: (req) => /^\/v1\/health\/(live|ready)(?:\?|$)/.test(req.url ?? ""),
            },
          },
        }),
        InfraModule.register(env),
        InternalModule,
        ReliabilityModule,
        HealthModule,
      ],
    };
  }
}
