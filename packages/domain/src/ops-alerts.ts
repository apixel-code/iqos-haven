/**
 * Operational alert transitions (roadmap step 125, ADR 0096). A rule fires when its check finds a
 * problem; it opens after `after` checks in a row (two for synthetic checks, architecture §15),
 * reminds while it stays open, and resolves on the first clean check. Pure: the monitor stores
 * the state and sends the notices.
 */
export interface AlertEvaluation {
  /** Stable rule key, e.g. `effects.backlog`. */
  readonly key: string;
  readonly firing: boolean;
  /** Counts and durations only; never personal data. */
  readonly summary: string;
  /** Checks in a row that must find the problem before the alert opens (at least 1). */
  readonly after: number;
}
export interface AlertState {
  readonly firing: boolean;
  readonly consecutive: number;
  readonly openedAt: Date | null;
  readonly lastNotifiedAt: Date | null;
  readonly resolvedAt: Date | null;
  readonly summary: string | null;
}
export interface AlertNotice {
  readonly key: string;
  readonly kind: "opened" | "reminder" | "resolved";
  readonly summary: string;
  readonly openedAt: Date;
}
export const CLOSED_ALERT: AlertState = {
  firing: false,
  consecutive: 0,
  openedAt: null,
  lastNotifiedAt: null,
  resolvedAt: null,
  summary: null,
};

export function nextAlertState(
  previous: AlertState,
  evaluation: AlertEvaluation,
  now: Date,
  remindAfterMs: number,
): { state: AlertState; notice: AlertNotice | null } {
  if (!evaluation.firing) {
    if (!previous.firing) return { state: { ...previous, consecutive: 0 }, notice: null };
    return {
      state: { ...previous, firing: false, consecutive: 0, resolvedAt: now },
      notice: {
        key: evaluation.key,
        kind: "resolved",
        summary: evaluation.summary,
        openedAt: previous.openedAt ?? now,
      },
    };
  }
  const consecutive = previous.consecutive + 1;
  if (!previous.firing) {
    if (consecutive < Math.max(1, evaluation.after))
      return { state: { ...previous, consecutive, summary: evaluation.summary }, notice: null };
    return {
      state: {
        firing: true,
        consecutive,
        openedAt: now,
        lastNotifiedAt: now,
        resolvedAt: null,
        summary: evaluation.summary,
      },
      notice: { key: evaluation.key, kind: "opened", summary: evaluation.summary, openedAt: now },
    };
  }
  const due =
    !previous.lastNotifiedAt || now.getTime() - previous.lastNotifiedAt.getTime() >= remindAfterMs;
  const state = {
    ...previous,
    consecutive,
    summary: evaluation.summary,
    ...(due ? { lastNotifiedAt: now } : {}),
  };
  return {
    state,
    notice: due
      ? {
          key: evaluation.key,
          kind: "reminder",
          summary: evaluation.summary,
          openedAt: previous.openedAt ?? now,
        }
      : null,
  };
}
