import type { NonceStore } from "./service-auth";

/** Minimal Redis surface (ioredis-compatible) so this package does not own a client. */
export interface RedisSetNx {
  set(key: string, value: string, mode: "EX", ttl: number, flag: "NX"): Promise<"OK" | null>;
}

/**
 * Shared replay protection across every verifying instance: SET key NX EX ttl. Keys are tiny
 * and expire with the clock window, so the noeviction queue Redis is an acceptable home.
 */
export class RedisNonceStore implements NonceStore {
  constructor(private readonly redis: RedisSetNx) {}

  async claim(key: string, ttlSeconds: number): Promise<boolean> {
    return (await this.redis.set(key, "1", "EX", ttlSeconds, "NX")) === "OK";
  }
}
