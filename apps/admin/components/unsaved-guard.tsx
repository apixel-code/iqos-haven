"use client";
import { useEffect, useRef } from "react";
import { confirmDialog } from "../lib/ui/confirm";
import {
  SAVED_EVENT,
  declareUnsaved,
  declaredUnsaved,
  leavesView,
  snapshotFields,
  unsavedMessage,
} from "../lib/unsaved";

type Field = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const REGION = "[data-unsaved]";

function snapshot(region: Element) {
  return snapshotFields(
    [...region.querySelectorAll<Field>("input, select, textarea")].map((field) => ({
      name: field.name,
      type: field.type,
      value: field.value,
      checked: field instanceof HTMLInputElement && field.checked,
    })),
  );
}

/**
 * Asks before leaving an editor with unsaved changes (parity G-A9, ADR 0093): admin links, and
 * buttons marked `data-leave` (Back, Sign out, tabs that close an editor), open a "Leave without
 * saving?" dialog; reloading or closing the tab gets the browser's own prompt. Mounted once in
 * the workspace shell. The browser's Back button is not intercepted.
 */
export function UnsavedChangesGuard() {
  useEffect(() => {
    const baselines = new WeakMap<Element, string>();
    const submitted = new Map<Element, string>();
    let bypass = false;
    const region = (target: EventTarget | null) =>
      target instanceof Element ? target.closest(REGION) : null;
    // Snapshot before the first change: focus or press reaches a field before its value changes.
    const remember = (event: Event) => {
      const found = region(event.target);
      if (found && !baselines.has(found)) baselines.set(found, snapshot(found));
    };
    const dirtyRegions = () =>
      [...document.querySelectorAll(REGION)].filter((found) => {
        const baseline = baselines.get(found);
        return baseline !== undefined && baseline !== snapshot(found);
      });
    const unsaved = () => {
      const [first] = dirtyRegions();
      return first ? (first.getAttribute("data-unsaved") ?? "this page") : declaredUnsaved();
    };
    const onSubmit = (event: Event) => {
      const found = region(event.target);
      if (found) submitted.set(found, snapshot(found));
    };
    const onSaved = () => {
      for (const [found, state] of submitted) baselines.set(found, state);
      submitted.clear();
    };
    const onClick = (event: MouseEvent) => {
      if (bypass || event.defaultPrevented) return;
      const target =
        event.target instanceof Element ? event.target.closest("a[href], [data-leave]") : null;
      if (!target) return;
      if (
        target instanceof HTMLAnchorElement &&
        !target.hasAttribute("data-leave") &&
        !leavesView(
          { href: target.href, target: target.target, download: target.hasAttribute("download") },
          {
            button: event.button,
            modified: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
          },
          window.location.href,
        )
      )
        return;
      const what = unsaved();
      if (!what) return;
      event.preventDefault();
      event.stopPropagation();
      // The prototype's confirmation dialog (parity G-A13); the safe choice has the focus.
      void confirmDialog({
        title: "Leave without saving?",
        body: unsavedMessage(what),
        ok: "Discard changes",
        cancel: "Keep editing",
        danger: true,
      }).then((discard) => {
        if (!discard) return;
        // The changes are discarded: forget them, then repeat the click unguarded.
        for (const found of dirtyRegions()) baselines.set(found, snapshot(found));
        bypass = true;
        try {
          (target as HTMLElement).click();
        } finally {
          bypass = false;
        }
      });
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!unsaved()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    document.addEventListener("focusin", remember, true);
    document.addEventListener("pointerdown", remember, true);
    document.addEventListener("keydown", remember, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("click", onClick, true);
    window.addEventListener(SAVED_EVENT, onSaved);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.removeEventListener("focusin", remember, true);
      document.removeEventListener("pointerdown", remember, true);
      document.removeEventListener("keydown", remember, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener(SAVED_EVENT, onSaved);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, []);

  return null;
}

/** For editors whose unsaved state lives in React: pass a name while there is some, else null. */
export function useUnsavedChanges(what: string | null) {
  const owner = useRef<symbol | null>(null);
  useEffect(() => {
    owner.current ??= Symbol("unsaved");
    const key = owner.current;
    declareUnsaved(key, what);
    return () => declareUnsaved(key, null);
  }, [what]);
}
