# 0093 — Unsaved-changes guard on admin editors

- Date: 2026-10-18
- Status: accepted
- Step(s): parity gap G-A9

## Context

Leaving an admin editor (Back, a sidebar link, Sign out, reload) dropped typed changes without a word. The prototype asks "Leave without saving?" ("Discard changes" / "Keep editing") whenever an editor is dirty. Marina chose G-A9 for launch (2026-10-17).

## Decision

- **One guard, mounted in the workspace shell** (`components/unsaved-guard.tsx`), not per-editor dialogs.
- **What counts as an editor:**
  - a region marked `data-unsaved="<what>"`, usually the editor's form. Marked: product, options, image alt text, brand/category (new and edit), discount codes, delivery charge and areas, settings groups, staff invitation/profile/role, manual order, order edit, cancellation, cash record and stock change;
  - editors whose state lives in React declare it with `useUnsavedChanges(what)`. The storefront content editor uses this, since its drafts outlive a tab switch.
  - Filter and search forms are not marked.
- **What counts as dirty:**
  - The guard snapshots a region's fields (values and checks; buttons and file pickers skipped, hidden inputs such as the chosen image included) on the first focus, press or key inside it. The region is dirty while its fields differ from that snapshot, so undoing an edit by hand clears it.
  - **After a save:** a submit records the submitted state. When an admin mutation then succeeds (`managementRequest` announces it), that state becomes the new snapshot. A failed save leaves the editor dirty.
- **What is guarded:**
  - same-tab clicks on admin links that change path or query (not new-tab, modified or download clicks, not in-page anchors);
  - buttons marked `data-leave`: Back buttons in editors, Sign out, and the Live/Trash tabs that unmount edit cards;
  - reload or closing the tab, through the browser's own `beforeunload` prompt.
- **Dialog:**
  - a native modal `<dialog>` with the prototype's copy, and "Keep editing" focused;
  - Escape keeps editing;
  - "Discard changes" forgets the changes and repeats the original click.
- **Not guarded:** the browser's Back button inside the app (App Router offers no supported way to cancel it). Programmatic navigation that does not start from a guarded click is not guarded either.

## Consequences

- New editors get the guard by adding `data-unsaved` (and `data-leave` on their own close buttons). A missing mark fails open: no dialog, as before.
- Any successful admin mutation re-snapshots regions waiting on a submit. A concurrent unrelated success could clear a failed save's dirty state; the window is one request and was judged acceptable.
