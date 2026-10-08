---
description: Implement one roadmap step end-to-end
argument-hint: <step number>
---

Implement roadmap step $ARGUMENTS.

1. `grep -n "^| $ARGUMENTS " docs/roadmap.md` → task, output, done condition. Also read that milestone's **Dependency** and **Gate** lines only.
2. Check `docs/business-inputs.md` for blockers. If blocked, build only the parts that don't depend on the missing input, behind config/flags, and list what's waiting.
3. Pull only the architecture sections this step needs (`grep -n` headings in `docs/architecture.md`, ranged read).
4. If UI is involved, look up symbols in `docs/prototype-map.md`; for anything wider, ask the `prototype-reader` subagent for a summary instead of reading the HTML yourself.
5. Plan briefly (≤10 bullets), then build in order: migration → contract → domain/application → repository/transaction → controller/guard → UI → tests.
6. Respect every invariant and prototype trap in root `CLAUDE.md`.
7. Run `/verify`. Fix failures.
8. For money/concurrency/auth/age-gate/order code, run the `invariant-reviewer` subagent on the diff and address findings.
9. Run `/handoff`, then commit: `step($ARGUMENTS): <summary>`.
