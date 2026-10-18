"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { answerConfirm, usePendingConfirm } from "../lib/ui/confirm";
import {
  dismissToast,
  newToastHostId,
  registerToastHost,
  TOAST_ACTION_MS,
  TOAST_MS,
  useToasts,
  useTopToastHost,
  type Toast,
} from "../lib/ui/toast";
import { Icon, type IconName } from "./icons";

/**
 * The admin prototype's layers (`openLayer`, `modal`, `drawer`, ADR 0097) on a modal `<dialog>`:
 * the dialog is the host, so focus stays inside, Escape closes it and focus goes back to what
 * opened it (the prototype has none of these). The prototype's scrim closes it on a click.
 */
export function Layer({
  open,
  onClose,
  label,
  children,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      element.showModal();
      // The dialog focuses its first control (Close); a marked one is the better start.
      element.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && element.open) element.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="layer-host"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {open && (
        <>
          <div className="scrim" onClick={onClose} />
          {children}
          {/* Above this layer in the top layer: a toast raised while it is open shows here. */}
          <Toasts />
        </>
      )}
    </dialog>
  );
}

function LayerHead({
  title,
  sub,
  icon,
  tone,
  onClose,
}: {
  title: string;
  sub?: ReactNode;
  icon?: IconName;
  tone?: "err" | "info" | "ok" | "warn";
  onClose: () => void;
}) {
  return (
    <>
      <div className="grab" aria-hidden="true" />
      <div className="modal-h">
        <div className="modal-ht">
          {icon && (
            <span className={`dlg-ic${tone ? ` tone-${tone}` : ""}`}>
              <Icon name={icon} size="lg" />
            </span>
          )}
          <div className="modal-tt">
            <h2>{title}</h2>
            {sub && <p>{sub}</p>}
          </div>
        </div>
        <button type="button" className="ibtn" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
    </>
  );
}

/** The prototype's `modal`: centred, a bottom sheet on a phone. */
export function Modal({
  open,
  onClose,
  title,
  sub,
  icon,
  tone,
  wide = false,
  foot,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: ReactNode;
  icon?: IconName;
  tone?: "err" | "info" | "ok" | "warn";
  wide?: boolean;
  foot?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Layer open={open} onClose={onClose} label={title}>
      <div className={wide ? "modal wide" : "modal"}>
        <LayerHead
          title={title}
          {...(sub ? { sub } : {})}
          {...(icon ? { icon } : {})}
          {...(tone ? { tone } : {})}
          onClose={onClose}
        />
        {children && <div className="modal-b">{children}</div>}
        {foot && <div className="modal-f">{foot}</div>}
      </div>
    </Layer>
  );
}

/** The prototype's `drawer`: a panel from the right, a tall bottom sheet on a phone. */
export function Drawer({
  open,
  onClose,
  title,
  sub,
  wide = false,
  foot,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  sub?: ReactNode;
  wide?: boolean;
  foot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Layer open={open} onClose={onClose} label={title}>
      <div className={wide ? "drawer wide" : "drawer"}>
        <LayerHead title={title} {...(sub ? { sub } : {})} onClose={onClose} />
        <div className="modal-b">{children}</div>
        {foot && <div className="modal-f">{foot}</div>}
      </div>
    </Layer>
  );
}

/** The one confirmation dialog of the workspace (`confirmDialog`, in place of window.confirm). */
export function ConfirmHost() {
  const request = usePendingConfirm();
  // The last question stays drawn while the dialog closes.
  const [shown, setShown] = useState(request);
  if (request && request !== shown) setShown(request);
  const answer = (value: boolean) => {
    if (request) answerConfirm(request.id, value);
  };
  return (
    <Modal
      open={request !== null}
      onClose={() => answer(false)}
      title={shown?.title ?? ""}
      icon={shown?.danger ? "alert" : "info"}
      tone={shown?.danger ? "err" : "info"}
      foot={
        <>
          {/* A destructive question starts on the safe choice, any other on the answer. */}
          <button
            type="button"
            className="btn btn-s"
            data-autofocus={shown?.danger ? "" : undefined}
            data-confirm-cancel=""
            onClick={() => answer(false)}
          >
            {shown?.cancel ?? "Cancel"}
          </button>
          <button
            type="button"
            className={shown?.danger ? "btn btn-d" : "btn btn-p"}
            data-autofocus={shown?.danger ? undefined : ""}
            data-confirm-ok=""
            onClick={() => answer(true)}
          >
            {shown?.ok ?? "Confirm"}
          </button>
        </>
      }
    >
      {shown?.body && <div className="prose confirm-b">{shown.body}</div>}
    </Modal>
  );
}

const TOAST_ICON: Record<Toast["kind"], IconName> = { ok: "check-c", err: "alert", info: "info" };

/**
 * Where toasts appear (prototype `#toasts`): one in the workspace and one inside each open layer;
 * only the topmost shows them. Errors are announced assertively, the rest politely.
 */
export function Toasts() {
  const [id] = useState(newToastHostId);
  useEffect(() => registerToastHost(id), [id]);
  const top = useTopToastHost();
  const all = useToasts();
  const shown = top === id ? all : [];
  return (
    <div className="toasts">
      <div role="status" aria-live="polite" className="toasts-list">
        {shown
          .filter((item) => item.kind !== "err")
          .map((item) => (
            <ToastItem key={item.id} item={item} />
          ))}
      </div>
      <div role="alert" aria-live="assertive" className="toasts-list">
        {shown
          .filter((item) => item.kind === "err")
          .map((item) => (
            <ToastItem key={item.id} item={item} />
          ))}
      </div>
    </div>
  );
}

function ToastItem({ item }: { item: Toast }) {
  const [held, setHeld] = useState(false);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (held) return;
    const wait = item.action ? TOAST_ACTION_MS : TOAST_MS;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const out = window.setTimeout(() => setLeaving(true), wait);
    const gone = window.setTimeout(() => dismissToast(item.id), wait + (reduced ? 0 : 220));
    return () => {
      window.clearTimeout(out);
      window.clearTimeout(gone);
    };
  }, [item, held]);
  return (
    <div
      className={leaving && !held ? "toast out" : "toast"}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className={`t-${item.kind}`}>
        <Icon name={TOAST_ICON[item.kind]} />
      </span>
      <span>{item.message}</span>
      {item.action && (
        <button
          type="button"
          onClick={() => {
            dismissToast(item.id);
            item.action!.run();
          }}
        >
          {item.action.label}
        </button>
      )}
      <button
        type="button"
        className="toast-x"
        aria-label="Dismiss"
        onClick={() => dismissToast(item.id)}
      >
        <Icon name="x" size="sm" />
      </button>
    </div>
  );
}
