import type { DeploymentEnv } from "@ih/config";

/**
 * BullMQ loses jobs if Redis evicts keys. The queue Redis must run `noeviction`.
 * Outside development a wrong policy is fatal; in development it is a loud warning.
 */
export function checkQueuePolicy(
  policy: string | undefined,
  env: DeploymentEnv,
): { ok: true } | { ok: false; fatal: boolean; message: string } {
  if (policy === "noeviction") return { ok: true };
  return {
    ok: false,
    fatal: env !== "development" && env !== "test",
    message: `Queue Redis maxmemory-policy is "${policy ?? "unknown"}"; it must be "noeviction".`,
  };
}
