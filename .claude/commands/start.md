---
description: Load minimal context for this session (progress, current step, blockers)
---

Session start. Keep context small.

1. Read `PROGRESS.md` (whole file — it is short).
2. Take the current step number N. Run `grep -n "^| N " docs/roadmap.md` and the gate line of its milestone. Do not read the rest of the roadmap.
3. `grep -n` `docs/business-inputs.md` for anything marked BLOCKS step N or its milestone.
4. `git status --short` and `git log --oneline -5`.

Then reply in 6 lines max (Bengali-English mix is fine):

- Step N — title
- Done condition
- Blockers (or "none")
- Unfinished work from last handoff
- Proposed first action
- Files you expect to touch

Do not start coding until Marina confirms, unless she already said "go".
