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
/** Test seam: integration tests pass an isolated-schema pool/database they own and close. */
export interface InfraOverrides {
  readonly pool: Pool;
  readonly database: Database;
}

const OWNS_DATABASE = Symbol("OWNS_DATABASE");

@Global()
@Module({})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(QUEUE_REDIS) private readonly redis: Redis,
    @Inject(DATABASE) private readonly database: Database,
    @Inject(OWNS_DATABASE) private readonly ownsDatabase: boolean,
  ) {}
  static register(env: ApiEnv, overrides?: InfraOverrides): DynamicModule {
    return {
      module: InfraModule,
      providers: [
        { provide: API_ENV, useValue: env },
        { provide: OWNS_DATABASE, useValue: !overrides },
        {
          provide: PG_POOL,
          useFactory: () =>
            overrides?.pool ??
            createPool({
              connectionString: env.DATABASE_URL,
              max: env.DATABASE_POOL_MAX,
              applicationName: "ih-api",
            }),
        },
        {
          provide: DATABASE,
          useFactory: (pool: Pool) => overrides?.database ?? createDatabase(pool),
          inject: [PG_POOL],
        },
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
    if (!this.ownsDatabase) return;
    await this.database.$disconnect();
    await this.pool.end();
  }
}
