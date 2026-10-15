"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/auth";
import {
  FormValidationError,
  managementError,
  managementRequest,
  type ResponseContract,
} from "../lib/management";
import { useSessionChecking } from "./session-shell";
export function useManagementResource<T>(path: string, schema: ResponseContract<T>) {
  const checking = useSessionChecking();
  const [snapshot, setSnapshot] = useState<{ path: string; revision: number; value: T } | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [denied, setDenied] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const running = useRef(false);
  const failure = useCallback((error: unknown, mutation: boolean) => {
    setMessage(managementError(error, mutation));
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      setSnapshot(null);
      setDenied(true);
      if (error.status === 401) window.location.replace("/login?reason=expired");
    }
    if (mutation && !(error instanceof FormValidationError)) setBlocked(true);
  }, []);
  useEffect(() => {
    const epoch = ++generation.current;
    const active = new AbortController();
    controller.current = active;
    void Promise.resolve().then(() => {
      if (active.signal.aborted) return;
      setSnapshot(null);
      setMessage("");
      setDenied(false);
      setBlocked(false);
      setBusy(true);
      running.current = true;
      managementRequest(path, schema, "GET", undefined, active.signal)
        .then((result) => {
          if (generation.current === epoch && !active.signal.aborted)
            setSnapshot({ path, revision, value: result });
        })
        .catch((error) => {
          if (generation.current === epoch && !active.signal.aborted) failure(error, false);
        })
        .finally(() => {
          if (generation.current === epoch) {
            setBusy(false);
            running.current = false;
          }
        });
    });
    return () => {
      generation.current = epoch + 1;
      active.abort();
      controller.current?.abort();
      running.current = false;
    };
  }, [path, schema, revision, failure]);
  async function run<R>(
    work: (signal: AbortSignal) => Promise<R>,
  ): Promise<{ ok: true; value: R } | { ok: false }> {
    if (running.current || blocked || denied || checking) return { ok: false };
    running.current = true;
    setBusy(true);
    setMessage("");
    const epoch = generation.current;
    const active = new AbortController();
    controller.current = active;
    try {
      const value = await work(active.signal);
      if (generation.current !== epoch || active.signal.aborted) return { ok: false };
      setMessage("Change saved.");
      return { ok: true, value };
    } catch (error) {
      if (generation.current === epoch && !active.signal.aborted) failure(error, true);
      return { ok: false };
    } finally {
      if (generation.current === epoch) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  const data = snapshot?.path === path && snapshot.revision === revision ? snapshot.value : null;
  function setData(update: T | null | ((current: T | null) => T | null)) {
    setSnapshot((current) => {
      const value =
        typeof update === "function"
          ? (update as (current: T | null) => T | null)(current?.value ?? null)
          : update;
      return value === null ? null : { path, revision, value };
    });
  }
  return {
    data,
    setData,
    message,
    busy,
    denied,
    disabled: busy || blocked || denied || checking,
    run,
    reload: () => setRevision((v) => v + 1),
  };
}
export function ResourceNotice({
  resource,
}: {
  resource: { message: string; busy: boolean; denied: boolean; reload: () => void };
}) {
  return (
    <div className="resource-toolbar">
      <div role="status" aria-live="polite">
        {resource.message || (resource.busy ? "Loading current values…" : "")}
      </div>
      <button
        type="button"
        className="secondary-button"
        onClick={resource.reload}
        disabled={resource.busy}
      >
        Reload current values
      </button>
      {resource.denied && (
        <p className="muted">Access unavailable. Return to your workspace or sign in again.</p>
      )}
    </div>
  );
}
export type Field = {
  name: string;
  label: string;
  kind?: "text" | "email" | "url" | "textarea" | "checkbox";
  required?: boolean;
  max?: number;
  help?: string;
  /** Shown but not editable (the server would refuse the change). */
  readOnly?: boolean;
};
export function Fields({ fields, value }: { fields: readonly Field[]; value: unknown }) {
  function current(path: string): unknown {
    let result: unknown = value;
    for (const part of path.split("."))
      result =
        result && typeof result === "object"
          ? (result as Record<string, unknown>)[part]
          : undefined;
    return result;
  }
  return (
    <div className="form-grid">
      {fields.map((field) => (
        <label key={field.name} className={field.kind === "textarea" ? "wide-field" : undefined}>
          <span>
            {field.label}
            {field.required ? " *" : ""}
          </span>
          {field.kind === "checkbox" ? (
            <input
              type="checkbox"
              name={field.name}
              defaultChecked={current(field.name) === true}
            />
          ) : field.kind === "textarea" ? (
            <textarea
              name={field.name}
              maxLength={field.max ?? 500}
              required={field.required}
              defaultValue={String(current(field.name) ?? "")}
              rows={3}
            />
          ) : (
            <input
              name={field.name}
              type={field.kind ?? "text"}
              maxLength={field.max ?? 500}
              required={field.required}
              readOnly={field.readOnly}
              defaultValue={String(current(field.name) ?? "")}
            />
          )}{" "}
          {field.help && <small className="muted">{field.help}</small>}
        </label>
      ))}
    </div>
  );
}
