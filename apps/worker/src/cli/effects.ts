import { parseArgs } from "node:util";
import type { DeadEffect } from "@ih/db";

/**
 * `pnpm ops:effects` (roadmap step 127, ADR 0099): the operator's view of dead background
 * effects and the audited replay of one after its cause was repaired. Lists codes, counts and
 * IDs only, never payloads. Replay moves dead → pending with a fresh attempt budget; the
 * reconciler re-enqueues it, so the worker must be running with sends configured on purpose.
 */
export interface EffectsDeps {
  readonly argv: readonly string[];
  list(options: { limit: number; consumer?: string }): Promise<DeadEffect[]>;
  replay(effectId: string, reason: string): Promise<void>;
  out(line: string): void;
}

export const EFFECTS_USAGE = `Usage: pnpm ops:effects [--consumer <name>] [--limit <1-200>]
       pnpm ops:effects --replay <effect id> --reason "<incident id: what was repaired>"

Lists dead background effects (oldest first). --replay puts one back to pending, audited.`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runEffects(deps: EffectsDeps): Promise<0 | 1 | 2> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...deps.argv],
      options: {
        consumer: { type: "string" },
        limit: { type: "string", default: "50" },
        replay: { type: "string" },
        reason: { type: "string" },
        help: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    deps.out(EFFECTS_USAGE);
    return 2;
  }
  if (values.help) {
    deps.out(EFFECTS_USAGE);
    return 0;
  }
  if (values.replay !== undefined) {
    const reason = (values.reason ?? "").trim();
    if (!UUID.test(values.replay) || reason.length < 8 || reason.length > 500) {
      deps.out(
        `An effect ID and a reason with the incident ID (8–500 characters) are required.\n\n${EFFECTS_USAGE}`,
      );
      return 2;
    }
    try {
      await deps.replay(values.replay, reason);
    } catch (error) {
      if ((error as { code?: unknown }).code === "EFFECT_NOT_DEAD") {
        deps.out(
          "That effect is not dead (already replayed, completed or unknown). Nothing changed.",
        );
        return 1;
      }
      throw error;
    }
    deps.out(
      `Effect ${values.replay} is pending again (audited as effect.replayed). The reconciler ` +
        "enqueues it within a minute; watch the effects.dead alert resolve.",
    );
    return 0;
  }
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    deps.out(EFFECTS_USAGE);
    return 2;
  }
  const dead = await deps.list(values.consumer ? { limit, consumer: values.consumer } : { limit });
  if (!dead.length) {
    deps.out("No dead effects.");
    return 0;
  }
  for (const effect of dead)
    deps.out(
      [
        effect.effectId,
        effect.consumer,
        effect.eventType,
        `event ${effect.eventId}`,
        `attempts ${effect.attempts}`,
        `replays ${effect.replays}`,
        effect.lastError,
        effect.diedAt.toISOString(),
      ].join("  "),
    );
  deps.out(
    `${dead.length} dead effect(s). Fix the cause named by the error code first, then replay ` +
      "each with --replay <id> --reason.",
  );
  return 0;
}
