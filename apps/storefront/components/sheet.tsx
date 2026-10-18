"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "@/components/icons";
import { Toasts } from "@/components/toasts";

const SLIDE_MS = 320;

/**
 * The prototype's sheet (`openSheet`/`shHead`, ADR 0097) on a modal `<dialog>`: the dialog is the
 * host (it keeps focus inside, closes on Escape and gives focus back), the prototype's backdrop
 * and panel slide in when it gains `open`. A tap on the backdrop closes it.
 *
 * `head` replaces the standard heading (the menu's wordmark; `null` for none, as in search) and
 * `bare` puts the children straight into the panel instead of the scrolling body. Reopened
 * while it is still sliding closed (an add right after closing), it simply slides back in.
 */
export function Sheet({
  open,
  onClose,
  title,
  heading,
  side = "bottom",
  className,
  style,
  clearBackdrop = false,
  head,
  bare = false,
  children,
  foot,
}: {
  open: boolean;
  onClose: () => void;
  /** The dialog's accessible name. */
  title: string;
  /** What the standard heading shows; `title` when left out. */
  heading?: ReactNode;
  side?: "bottom" | "right" | "left" | "top" | "pop";
  className?: string;
  style?: CSSProperties;
  /** The prototype's faint backdrop for the cart pop-over. */
  clearBackdrop?: boolean;
  head?: ReactNode;
  bare?: boolean;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open) {
      if (!element.open) element.showModal();
      // Two frames: the panel is painted closed first, so its slide-in transition runs.
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(frame);
    }
    if (element.open) {
      setShown(false);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      // Cleared if the sheet is opened again before it has finished sliding out.
      const timer = window.setTimeout(() => element.close(), reduced ? 0 : SLIDE_MS);
      return () => window.clearTimeout(timer);
    }
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className={shown ? "sheet-host open" : "sheet-host"}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className={clearBackdrop ? "backdrop clear" : "backdrop"} onClick={onClose} />
      <div className={`sheet ${side}${className ? ` ${className}` : ""}`} style={style}>
        {head === undefined ? (
          <>
            <div className="grab" aria-hidden="true" />
            <div className="sh-head">
              <h2>{heading ?? title}</h2>
              <button type="button" className="ibtn" aria-label="Close" onClick={onClose}>
                <Icon name="x" />
              </button>
            </div>
          </>
        ) : (
          head
        )}
        {bare ? children : <div className="sh-body">{children}</div>}
        {foot && <div className="sh-foot">{foot}</div>}
      </div>
      {/* Above this sheet in the top layer: a toast raised while it is open shows here. */}
      {open && <Toasts />}
    </dialog>
  );
}
