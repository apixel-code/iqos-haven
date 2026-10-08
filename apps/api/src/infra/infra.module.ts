import {
  Global,
  Inject,
  Module,
  type DynamicModule,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { ApiEnv } from "@ih/config";
import { createDatabase, createPool, type Database, type Pool } from "@ih/db";
import { createLogger, errorSummary } from "@ih/logger";
import Redis from "ioredis";
import { API_ENV, DATABASE, PG_POOL, QUEUE_REDIS } from "./tokens";
@Global()
@Module({})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(QUEUE_REDIS) private readonly redis: Redis,
    @Inject(DATABASE) private readonly database: Database,
  ) {}
  static register(env: ApiEnv): DynamicModule {
    return {
      module: InfraModule,
      providers: [
        { provide: API_ENV, useValue: env },
        {
          provide: PG_POOL,
          useFactory: () =>
            createPool({
              connectionString: env.DATABASE_URL,
              max: env.DATABASE_POOL_MAX,
              applicationName: "ih-api",
            }),
        },
        { provide: DATABASE, useFactory: (pool: Pool) => createDatabase(pool), inject: [PG_POOL] },
        {
          provide: QUEUE_REDIS,
          useFactory: () => {
            const client = new Redis(env.QUEUE_REDIS_URL, {
              lazyConnect: true,
              maxRetriesPerRequest: 1,
              enableOfflineQueue: false,
              connectTimeout: 2000,
              commandTimeout: 2000,
            });
            const log = createLogger({ service: "api-queue", level: env.LOG_LEVEL });
            client.on("error", (error) => log.warn(errorSummary(error), "queue connection error"));
            return client;
          },
        },
      ],
      exports: [API_ENV, PG_POOL, DATABASE, QUEUE_REDIS],
    };
  }
  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.database.$disconnect();
    await this.pool.end();
  }
}
