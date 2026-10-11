import { loadEnv, storefrontEnvSchema, type StorefrontEnv } from "@ih/config";

let cached: StorefrontEnv | undefined;

/** Validated server configuration, read once per process. Server code only. */
export function storefrontEnv(): StorefrontEnv {
  return (cached ??= loadEnv(storefrontEnvSchema));
}
