---
description: Update PROGRESS.md so the next session can resume cold
---

Update `PROGRESS.md` (edit in place, don't rewrite unrelated sections):

- **Current position**: milestone, step, status (not started / in progress / done), branch.
- **Next action (exact)**: one concrete instruction a fresh session can execute without chat history.
- **Blockers**: only those affecting current/next step.
- **Gates passed**: tick a milestone only if its Gate condition was demonstrated.
- **Steps done**: append `N — summary — <short commit hash or "uncommitted">` if finished.
- **Known deviations**: anything differing from architecture, with ADR link.
- **Last session handoff**: today's date, what was done, files touched (paths only), tests run + result, what is unfinished.
- Move the previous "Last session handoff" into **History (summary)** as 1–2 lines.

Keep the file under ~120 lines; condense History if needed. Also record any new client question in `docs/business-inputs.md`.
Finish with one line: "Handoff saved — safe to /clear."
