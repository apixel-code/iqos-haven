import { Global, Module } from "@nestjs/common";
import { RedisNonceStore, type NonceStore } from "@ih/platform";
import type Redis from "ioredis";
import { QUEUE_REDIS } from "../infra/tokens";
import { NONCE_STORE, ServiceAuthGuard } from "./service-auth.guard";

const NONCE_TIMEOUT_MS = 2_000;

/**
 * Private service-auth framework. Replay protection is shared by every API instance through the
 * queue Redis (SET NX EX); if Redis is unreachable, internal calls are denied (fail closed).
 * Internal controllers arrive with their features (e.g. step 52 catalogue invalidation).
 */
@Global()
@Module({
  providers: [
    {
      provide: NONCE_STORE,
      inject: [QUEUE_REDIS],
      useFactory: (redis: Redis): NonceStore =>
        new RedisNonceStore({
          set: async (key, value, mode, ttl, flag) => {
            if (redis.status === "wait" || redis.status === "end") await redis.connect();
            return Promise.race([
              redis.set(key, value, mode, ttl, flag),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error("nonce store timeout")),
                  NONCE_TIMEOUT_MS,
                ).unref(),
              ),
            ]);
          },
        }),
    },
    ServiceAuthGuard,
  ],
  exports: [NONCE_STORE, ServiceAuthGuard],
})
export class InternalModule {}
