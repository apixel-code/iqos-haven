"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/icons";
import {
  dismissToast,
  newToastHostId,
  registerToastHost,
  TOAST_ACTION_MS,
  TOAST_MS,
  useToast,
  useTopToastHost,
} from "@/lib/ui/toast";

const OUT_MS = 260;

/**
 * Where toasts appear (prototype `#toasts`): one in the store shell and one inside each open
 * sheet; only the topmost shows the toast. The region is always there, so screen readers hear
 * a new message.
 */
export function Toasts() {
  const [id] = useState(newToastHostId);
  useEffect(() => registerToastHost(id), [id]);
  const top = useTopToastHost();
  const message = useToast();
  const [held, setHeld] = useState(false);
  const [leaving, setLeaving] = useState<number | null>(null);
  const shown = top === id ? message : null;

  useEffect(() => {
    if (!shown || held) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const wait = shown.action ? TOAST_ACTION_MS : TOAST_MS;
    const out = window.setTimeout(() => setLeaving(shown.id), wait);
    const gone = window.setTimeout(() => dismissToast(shown.id), wait + (reduced ? 0 : OUT_MS));
    return () => {
      window.clearTimeout(out);
      window.clearTimeout(gone);
    };
  }, [shown, held]);

  return (
    <div className="toasts" role="status" aria-live="polite">
      {shown && (
        <div
          key={shown.id}
          className={leaving === shown.id && !held ? "toast out" : "toast"}
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={() => setHeld(false)}
        >
          {shown.image ? (
            <span className="th">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={shown.image} alt="" width={40} height={44} />
            </span>
          ) : (
            <Icon name="check" />
          )}
          <span className="t">
            <b>{shown.title}</b>
            {shown.sub && <span>{shown.sub}</span>}
          </span>
          {shown.action && (
            <button
              type="button"
              onClick={() => {
                dismissToast(shown.id);
                setHeld(false);
                shown.action!.run();
              }}
            >
              {shown.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
