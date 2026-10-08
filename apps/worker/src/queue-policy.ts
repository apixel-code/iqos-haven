import type { DeploymentEnv } from "@ih/config";

/** Fields from `INFO memory`. INFO works on managed Redis where CONFIG is disabled. */
export interface QueueRedisState {
  readonly policy: string | undefined;
  readonly usedMemory: number | undefined;
  readonly maxMemory: number | undefined;
}

export type PolicyCheck = { ok: true } | { ok: false; fatal: boolean; message: string };

/** Warn before BullMQ writes start failing with OOM under `noeviction`. */
export const MEMORY_WARN_RATIO = 0.8;

export function parseRedisInfo(info: string): QueueRedisState {
  const fields = new Map<string, string>();
  for (const line of info.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index > 0 && !line.startsWith("#"))
      fields.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  const number = (key: string) => {
    const value = Number(fields.get(key));
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };
  return {
    policy: fields.get("maxmemory_policy") || undefined,
    usedMemory: number("used_memory"),
    maxMemory: number("maxmemory"),
  };
}

/**
 * BullMQ loses jobs if Redis evicts keys. The queue Redis must run `noeviction`.
 * Outside development/test a wrong or unreadable policy is fatal; locally it is a loud warning.
 */
export function checkQueuePolicy(policy: string | undefined, env: DeploymentEnv): PolicyCheck {
  if (policy === "noeviction") return { ok: true };
  return {
    ok: false,
    fatal: env !== "development" && env !== "test",
    message: `Queue Redis maxmemory-policy is "${policy ?? "unknown"}"; it must be "noeviction".`,
  };
}

/** Memory pressure ratio, or undefined when Redis has no maxmemory limit configured. */
export function memoryPressure(state: QueueRedisState): number | undefined {
  if (!state.maxMemory || state.usedMemory === undefined) return undefined;
  return state.usedMemory / state.maxMemory;
}
