"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

/**
 * The admin prototype's popover (`openPop`, ADR 0097): a small panel under its button, right-
 * aligned to it unless `align="left"`, kept 8 px inside the window and flipped above when there
 * is no room below. A press outside or Escape closes it; Escape gives focus back to the button.
 * On a phone `sheet` turns it into a bottom sheet (the notification panel).
 */
export function Pop({
  anchor,
  open,
  onClose,
  align = "right",
  className,
  label,
  role = "dialog",
  minWidth,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  align?: "left" | "right";
  className?: string;
  label: string;
  role?: "dialog" | "menu";
  /** At least this wide (the search results match the field). */
  minWidth?: number;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ top: number; left: number; width?: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const box = anchor.current?.getBoundingClientRect();
      const element = panel.current;
      if (!box || !element) return;
      const width = Math.max(element.offsetWidth, minWidth ?? 0);
      const height = element.offsetHeight;
      let left = align === "left" ? box.left : box.right - width;
      left = Math.min(Math.max(8, left), window.innerWidth - width - 8);
      let top = box.bottom + 6;
      if (top + height > window.innerHeight - 8 && box.top - height - 6 > 8)
        top = box.top - height - 6;
      setPlace({ top, left, ...(minWidth ? { width } : {}) });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, anchor, align, minWidth, children]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (panel.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
      anchor.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open, onClose, anchor]);

  if (!open) return null;
  return (
    <div
      ref={panel}
      className={`pop pop-fixed${className ? ` ${className}` : ""}`}
      role={role}
      aria-label={label}
      style={
        place
          ? { top: place.top, left: place.left, ...(place.width ? { width: place.width } : {}) }
          : { visibility: "hidden" }
      }
    >
      {children}
    </div>
  );
}
