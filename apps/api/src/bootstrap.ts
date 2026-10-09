import { VersioningType, type INestApplication, type Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import type { ApiEnv } from "@ih/config";
import { Logger } from "nestjs-pino";
import { createLogger } from "@ih/logger";
import { AppModule } from "./app.module";
import type { InfraOverrides } from "./infra/infra.module";
import { requestId } from "./http/request-id";
import { ApiErrorFilter } from "./http/error.filter";
import { ZodValidationPipe } from "./http/zod-validation.pipe";
export async function createApp(
  env: ApiEnv,
  overrides?: InfraOverrides,
  testModules?: readonly Type[],
): Promise<INestApplication> {
  if (testModules?.length && env.NODE_ENV === "production")
    throw new Error("Test modules are not allowed in production");
  const adapter = new FastifyAdapter({ bodyLimit: 32768, trustProxy: false, genReqId: requestId });
  adapter.getInstance().addHook("onRequest", (req, reply, done) => {
    const id = requestId(req.raw);
    req.id = id;
    reply.header("x-request-id", id);
    done();
  });
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(env, overrides, testModules),
    adapter,
    {
      bufferLogs: true,
      // Raw request bytes are part of the internal service-auth signature.
      rawBody: true,
    },
  );
  app.useLogger(app.get(Logger));
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(new ApiErrorFilter(createLogger({ service: "api", level: env.LOG_LEVEL })));
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  app.enableShutdownHooks();
  return app;
}
