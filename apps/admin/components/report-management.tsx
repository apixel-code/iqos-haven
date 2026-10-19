"use client";
import { confirmDialog } from "../lib/ui/confirm";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  reportJobSchema,
  reportJobsResponseSchema,
  type ReportJob,
  type ReportParams,
} from "@ih/contracts";
import { analyticsRange } from "../lib/analytics";

const REPORTS = [
  {
    type: "sales",
    label: "Sales",
    help: "Per Dubai day: orders and amounts on the basis you choose.",
    ranged: true,
  },
  {
    type: "orders",
    label: "Orders",
    help: "One row per order line placed in the range, with customer name and phone.",
    ranged: true,
  },
  {
    type: "products",
    label: "Products",
    help: "Units and net sales of what was delivered in the range.",
    ranged: true,
  },
  {
    type: "inventory",
    label: "Inventory",
    help: "Stock of every variant right now.",
    ranged: false,
  },
  {
    type: "customers",
    label: "Customers",
    help: "Everyone who ordered, with order counts and spend. Contains names and phones.",
    ranged: false,
  },
] as const;
type ReportType = (typeof REPORTS)[number]["type"];
const PERSONAL: readonly ReportType[] = ["orders", "customers"];
const STATUS: Record<ReportJob["status"], string> = {
  ready: "Ready",
  queued: "Waiting to be built",
  running: "Being built",
  completed: "Ready",
  failed: "Could not be built",
  expired: "Expired",
};
const dubaiTime = (iso: string) =>
  new Intl.DateTimeFormat("en-AE", {
    timeZone: "Asia/Dubai",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
const describe = (report: ReportParams) =>
  "from" in report
    ? `${report.from} to ${report.to}${report.type === "sales" ? `, ${report.basis}` : ""}`
    : "snapshot";

/**
 * Reports (roadmap step 112, ADR 0078). Request one of the five CSV reports, see your own
 * requests, download while available. Every right is decided by the API: the screen only asks
 * before a report with personal data, and keeps nothing on the device.
 */
export function ReportManagement({
  canExport,
  canExportCustomers,
}: {
  canExport: boolean;
  canExportCustomers: boolean;
}) {
  const [jobs, setJobs] = useState<ReportJob[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [type, setType] = useState<ReportType>("sales");
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const range = analyticsRange(30, new Date());
  const pending = useRef<{ key: string; commandId: string } | null>(null);
  const load = useCallback(() => {
    fetch("/api/v1/admin/reports", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(String(response.status));
        setJobs(reportJobsResponseSchema.parse(await response.json()).items);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);
  useEffect(load, [load]);
  // While something is being built, look again every few seconds.
  const building = jobs?.some((job) => job.status === "queued" || job.status === "running");
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [building, load]);

  const choice = REPORTS.find((report) => report.type === type)!;
  const allowed = canExport && (!PERSONAL.includes(type) || canExportCustomers);
  async function submit(form: FormData) {
    const report = (
      choice.ranged
        ? {
            type,
            from: String(form.get("from")),
            to: String(form.get("to")),
            ...(type === "sales" ? { basis: String(form.get("basis")) } : {}),
          }
        : { type }
    ) as ReportParams;
    if (
      PERSONAL.includes(type) &&
      !(await confirmDialog({
        title: "Export customer details?",
        body: "This file contains customer names and phone numbers. Store it securely and do not share it outside the business.",
        ok: "Export",
      }))
    )
      return;
    // The same request retried (a lost answer) keeps its command ID, so it never doubles.
    const key = JSON.stringify(report);
    if (pending.current?.key !== key) pending.current = { key, commandId: crypto.randomUUID() };
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/v1/admin/reports", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandId: pending.current.commandId, report }),
      });
      if (response.status === 400)
        setNotice("Choose real dates, at most a year, ending today at the latest.");
      else if (response.status === 403) setNotice("You are not allowed to export this report.");
      else if (!response.ok) setNotice("The report could not be requested. Try again.");
      else {
        const job = reportJobSchema.parse(await response.json());
        pending.current = null;
        setNotice(
          job.delivery === "stream"
            ? "Ready: download it below within 15 minutes."
            : "It is large, so it is being built. It appears below when ready and is kept 7 days.",
        );
        load();
      }
    } catch {
      setNotice("The report could not be requested. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dashboard">
      {canExport && (
        <section className="management-card" aria-labelledby="rep-new">
          <h2 id="rep-new">New report</h2>
          <form
            className="form-grid"
            onSubmit={(event) => {
              event.preventDefault();
              void submit(new FormData(event.currentTarget));
            }}
          >
            <label>
              Report
              <select
                name="type"
                value={type}
                onChange={(event) => setType(event.target.value as ReportType)}
              >
                {REPORTS.map((report) => (
                  <option key={report.type} value={report.type}>
                    {report.label}
                  </option>
                ))}
              </select>
            </label>
            {choice.ranged && (
              <>
                <label>
                  From <input type="date" name="from" defaultValue={range.from} required />
                </label>
                <label>
                  To <input type="date" name="to" defaultValue={range.to} max={range.to} required />
                </label>
              </>
            )}
            {type === "sales" && (
              <label>
                Basis
                <select name="basis" defaultValue="booked">
                  <option value="booked">Booked (by order date)</option>
                  <option value="delivered">Delivered (by delivery date)</option>
                  <option value="collected">Cash collected (by collection date)</option>
                </select>
              </label>
            )}
            <p className="muted small wide-field">
              {choice.help} Days are Asia/Dubai; amounts in AED as entered (no separate VAT).
            </p>
            <div className="form-actions wide-field">
              <button className="primary-button" type="submit" disabled={busy || !allowed}>
                {busy ? "Requesting…" : "Request report"}
              </button>
              {!allowed && (
                <span className="muted small">
                  This report needs the right to export customer data.
                </span>
              )}
            </div>
          </form>
          {notice && (
            <p className="notice" role="status">
              {notice}
            </p>
          )}
        </section>
      )}
      <section className="management-card" aria-labelledby="rep-list">
        <div className="inline-row">
          <h2 id="rep-list">Your reports</h2>
          <button className="text-button" type="button" onClick={load}>
            Refresh
          </button>
        </div>
        <p className="muted small">
          Only reports you requested. Download links are checked again each time.
        </p>
        {failed && (
          <p className="notice" role="alert">
            Your reports could not be loaded.
          </p>
        )}
        {jobs && !jobs.length && <p className="muted">No reports yet.</p>}
        {jobs && jobs.length > 0 && (
          <div className="order-table-wrap">
            <table className="order-table">
              <thead>
                <tr>
                  <th>Report</th>
                  <th>Range</th>
                  <th>Requested</th>
                  <th>Status</th>
                  <th>Rows</th>
                  <th>
                    <span className="sr-only">Download</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{REPORTS.find((report) => report.type === job.type)?.label ?? job.type}</td>
                    <td>{describe(job.report)}</td>
                    <td>{dubaiTime(job.createdAt)}</td>
                    <td>
                      {job.available
                        ? `Ready until ${dubaiTime(job.expiresAt!)}`
                        : job.status === "ready" || job.status === "completed"
                          ? "Expired"
                          : STATUS[job.status]}
                    </td>
                    <td>{job.rowCount ?? `~${job.estimatedRows}`}</td>
                    <td>
                      {job.available && canExport ? (
                        <a
                          className="secondary-button"
                          href={`/api/v1/admin/reports/${job.id}/download`}
                        >
                          Download CSV
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
