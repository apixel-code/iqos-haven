import { describe, expect, it } from "vitest";
import { CLOSED_ALERT, nextAlertState, type AlertEvaluation } from "./ops-alerts";

const HOUR = 3_600_000;
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 18, 8, minutes));
const firing = (after = 1): AlertEvaluation => ({
  key: "effects.backlog",
  firing: true,
  summary: "oldest unfinished effect 7 min",
  after,
});
const clean: AlertEvaluation = { ...firing(), firing: false, summary: "ok" };

describe("ops alert transitions (step 125)", () => {
  it("opens on the first finding, stays quiet, reminds, then resolves once", () => {
    const opened = nextAlertState(CLOSED_ALERT, firing(), at(0), 6 * HOUR);
    expect(opened.notice).toMatchObject({ kind: "opened" });
    expect(opened.state).toMatchObject({ firing: true, consecutive: 1, openedAt: at(0) });
    const quiet = nextAlertState(opened.state, firing(), at(1), 6 * HOUR);
    expect(quiet.notice).toBeNull();
    const later = new Date(at(0).getTime() + 6 * HOUR);
    const reminder = nextAlertState(quiet.state, firing(), later, 6 * HOUR);
    expect(reminder.notice).toMatchObject({ kind: "reminder", openedAt: at(0) });
    expect(reminder.state.lastNotifiedAt).toEqual(later);
    const resolved = nextAlertState(reminder.state, clean, at(30), 6 * HOUR);
    expect(resolved.notice).toMatchObject({ kind: "resolved", openedAt: at(0) });
    expect(resolved.state).toMatchObject({ firing: false, consecutive: 0, resolvedAt: at(30) });
    expect(nextAlertState(resolved.state, clean, at(31), 6 * HOUR).notice).toBeNull();
  });

  it("needs two failures in a row when the rule asks for it", () => {
    const first = nextAlertState(CLOSED_ALERT, firing(2), at(0), HOUR);
    expect(first.notice).toBeNull();
    expect(first.state).toMatchObject({ firing: false, consecutive: 1 });
    // A pass in between starts the count again.
    const reset = nextAlertState(first.state, { ...clean, after: 2 }, at(1), HOUR);
    expect(reset.state.consecutive).toBe(0);
    const again = nextAlertState(reset.state, firing(2), at(2), HOUR);
    const second = nextAlertState(again.state, firing(2), at(3), HOUR);
    expect(second.notice).toMatchObject({ kind: "opened" });
  });
});
