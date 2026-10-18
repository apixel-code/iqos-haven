/**
 * Unsaved-changes guard (parity G-A9, ADR 0093): the pure parts.
 *
 * An editor is a region marked `data-unsaved="<what>"` (usually its form). The guard snapshots
 * its fields when the user first touches it and calls it dirty while the fields differ from that
 * snapshot. A successful save (any admin mutation that succeeds after the region was submitted)
 * makes the submitted state the new snapshot. Editors whose state lives in React rather than in
 * fields declare it instead (`declareUnsaved`).
 */

export interface FieldState {
  readonly name: string;
  readonly type: string;
  readonly value: string;
  readonly checked: boolean;
}

/** Field types that carry no editable value of their own (a file's chosen asset is a hidden input). */
const SKIPPED_TYPES = new Set(["button", "submit", "reset", "image", "file"]);

/** A comparable snapshot of a region's fields, in document order. */
export function snapshotFields(fields: Iterable<FieldState>): string {
  const parts: unknown[] = [];
  for (const field of fields) {
    if (SKIPPED_TYPES.has(field.type)) continue;
    parts.push(
      field.type === "checkbox" || field.type === "radio"
        ? [field.name, field.type, field.value, field.checked]
        : [field.name, field.type, field.value],
    );
  }
  return JSON.stringify(parts);
}

/**
 * Whether a link click leaves the current view inside the admin: same origin, same tab, a plain
 * left click, and not just a jump within the page.
 */
export function leavesView(
  link: { href: string; target: string; download: boolean },
  click: { button: number; modified: boolean },
  current: string,
): boolean {
  if (click.button !== 0 || click.modified || link.download) return false;
  if (link.target && link.target !== "_self") return false;
  let to: URL;
  let from: URL;
  try {
    to = new URL(link.href, current);
    from = new URL(current);
  } catch {
    return false;
  }
  if (to.origin !== from.origin) return false;
  return to.pathname !== from.pathname || to.search !== from.search;
}

/** The leave dialog's body text. */
export function unsavedMessage(what: string) {
  return `You have unsaved changes to ${what}. If you leave now, they will be lost.`;
}

/** Fired on `window` after an admin mutation succeeds. */
export const SAVED_EVENT = "ih:admin-saved";

export function announceSaved() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SAVED_EVENT));
}

const declared = new Map<symbol, string>();

/** Declares (a name) or clears (null) unsaved state held outside form fields. */
export function declareUnsaved(owner: symbol, what: string | null) {
  if (what) declared.set(owner, what);
  else declared.delete(owner);
}

/** The first declared unsaved editor, if any. */
export function declaredUnsaved(): string | null {
  for (const what of declared.values()) return what;
  return null;
}
