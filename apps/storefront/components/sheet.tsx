"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/icons";

const SLIDE_MS = 320;

/**
 * The prototype's sheet (`openSheet`/`shHead`, ADR 0097) on a modal `<dialog>`: the dialog is the
 * host (it keeps focus inside, closes on Escape and gives focus back), the prototype's backdrop
 * and panel slide in when it gains `open`. A tap on the backdrop closes it.
 */
export function Sheet({
  open,
  onClose,
  title,
  side = "bottom",
  className,
  children,
  foot,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  side?: "bottom" | "right" | "left";
  className?: string;
  children: ReactNode;
  foot?: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      // Two frames: the panel is painted closed first, so its slide-in transition runs.
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(frame);
    }
    if (!open && element.open) {
      setShown(false);
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
      <div className="backdrop" onClick={onClose} />
      <div className={`sheet ${side}${className ? ` ${className}` : ""}`}>
        <div className="grab" aria-hidden="true" />
        <div className="sh-head">
          <h2>{title}</h2>
          <button type="button" className="ibtn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="sh-body">{children}</div>
        {foot && <div className="sh-foot">{foot}</div>}
      </div>
    </dialog>
  );
}
