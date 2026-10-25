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
import { Icon } from "./icons";
import { PageHead } from "./page-head";

const REPORTS = [
  {
    type: "sales",
    label: "Sales",
    help: "Per Dubai day: orders and amounts on the basis you choose.",
    ranged: true,
    icon: "chart",
  },
  {
    type: "orders",
    label: "Orders",
    help: "One row per order line placed in the range, with customer name and phone.",
    ranged: true,
    icon: "orders",
  },
  {
    type: "products",
    label: "Products",
    help: "Units and net sales of what was delivered in the range.",
    ranged: true,
    icon: "box",
  },
  {
    type: "inventory",
    label: "Inventory",
    help: "Stock of every variant right now.",
    ranged: false,
    icon: "layers",
  },
  {
    type: "customers",
    label: "Customers",
    help: "Everyone who ordered, with order counts and spend. Contains names and phones.",
    ranged: false,
    icon: "users",
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

  const jobLabel = (job: ReportJob) =>
    REPORTS.find((report) => report.type === job.type)?.label ?? job.type;
  const jobStatus = (job: ReportJob) =>
    job.available ? (
      <span className="tag ok">
        <Icon name="check" size="sm" />
        Ready until {dubaiTime(job.expiresAt!)}
      </span>
    ) : job.status === "ready" || job.status === "completed" || job.status === "expired" ? (
      <span className="tag">
        <Icon name="clock" size="sm" />
        Expired
      </span>
    ) : job.status === "failed" ? (
      <span className="tag out">
        <Icon name="alert" size="sm" />
        {STATUS[job.status]}
      </span>
    ) : (
      <span className="tag low">
        <Icon name="clock" size="sm" />
        {STATUS[job.status]}
      </span>
    );
  const download = (job: ReportJob) =>
    job.available && canExport ? (
      <a className="btn btn-s btn-sm" href={`/api/v1/admin/reports/${job.id}/download`}>
        <Icon name="download" size="sm" />
        Download CSV
      </a>
    ) : null;

  return (
    <>
      <PageHead
        title="Reports"
        sub="Structured data for accounting, stock counts and planning. Export as CSV."
      />
      {canExport && (
        <div className="split rep">
          <nav className="card rep-menu" aria-label="Reports">
            <div className="menu">
              {REPORTS.map((report) => {
                const locked = PERSONAL.includes(report.type) && !canExportCustomers;
                return (
                  <button
                    key={report.type}
                    type="button"
                    aria-pressed={type === report.type}
                    onClick={() => {
                      setType(report.type);
                      setNotice(null);
                    }}
                  >
                    <Icon name={report.icon} />
                    <span>{report.label}</span>
                    {locked ? (
                      <Icon name="lock" size="sm" />
                    ) : (
                      type === report.type && <Icon name="cr" size="sm" />
                    )}
                  </button>
                );
              })}
            </div>
          </nav>
          <section className="card" aria-labelledby="rep-new">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit(new FormData(event.currentTarget));
              }}
            >
              <div className="card-h">
                <div>
                  <h2 id="rep-new">{choice.label}</h2>
                  <p className="sub">{choice.help}</p>
                </div>
                <button className="btn btn-p" type="submit" disabled={busy || !allowed}>
                  <Icon name="download" />
                  {busy ? "Requesting…" : "Export CSV"}
                </button>
              </div>
              <div className="card-b form" key={type}>
                {choice.ranged ? (
                  <div className="fgrid c2 even">
                    <div className="field">
                      <label className="label" htmlFor="rep-from">
                        From
                      </label>
                      <input
                        id="rep-from"
                        className="input"
                        type="date"
                        name="from"
                        defaultValue={range.from}
                        required
                      />
                    </div>
                    <div className="field">
                      <label className="label" htmlFor="rep-to">
                        To
                      </label>
                      <input
                        id="rep-to"
                        className="input"
                        type="date"
                        name="to"
                        defaultValue={range.to}
                        max={range.to}
                        required
                      />
                    </div>
                  </div>
                ) : (
                  <p className="row small muted rep-meta">
                    <Icon name="clock" size="sm" />
                    Current snapshot, taken when you export.
                  </p>
                )}
                {type === "sales" && (
                  <div className="field">
                    <label className="label" htmlFor="rep-basis">
                      Basis
                    </label>
                    <select id="rep-basis" className="select" name="basis" defaultValue="booked">
                      <option value="booked">Booked (by order date)</option>
                      <option value="delivered">Delivered (by delivery date)</option>
                      <option value="collected">Cash collected (by collection date)</option>
                    </select>
                  </div>
                )}
                <p className="help">
                  Days are Asia/Dubai; amounts in AED as entered (no separate VAT).
                </p>
                {PERSONAL.includes(type) &&
                  (allowed ? (
                    <div className="note warn">
                      <Icon name="lock" />
                      <p>
                        Contains customer names and phone numbers. You are asked once more before it
                        is made.
                      </p>
                    </div>
                  ) : (
                    <div className="note warn">
                      <Icon name="lock" />
                      <p>This report needs the right to export customer data.</p>
                    </div>
                  ))}
                {notice && (
                  <div
                    className={
                      notice.startsWith("Ready") || notice.startsWith("It is large")
                        ? "note ok"
                        : "note err"
                    }
                    role="status"
                  >
                    <Icon
                      name={
                        notice.startsWith("Ready") || notice.startsWith("It is large")
                          ? "check-c"
                          : "alert"
                      }
                    />
                    <p>{notice}</p>
                  </div>
                )}
              </div>
            </form>
          </section>
        </div>
      )}
      <section className="tbl-wrap" aria-labelledby="rep-list">
        <div className="card-h an-tbl-h">
          <div>
            <h2 id="rep-list">Your reports</h2>
            <p className="sub">
              Only reports you requested. Download links are checked again each time.
            </p>
          </div>
          <button className="btn btn-g btn-sm" type="button" onClick={load}>
            <Icon name="refresh" size="sm" />
            Refresh
          </button>
        </div>
        {failed && (
          <div className="card-b">
            <div className="note err" role="alert">
              <Icon name="alert" />
              <p>Your reports could not be loaded.</p>
            </div>
          </div>
        )}
        {jobs && !jobs.length && (
          <div className="empty dash-empty">
            <div className="ic">
              <Icon name="file" />
            </div>
            <h3>No reports yet</h3>
            <p>Reports you export appear here while they can be downloaded.</p>
          </div>
        )}
        {jobs && jobs.length > 0 && (
          <>
            <div className="tbl-scroll only-d">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Report</th>
                    <th>Range</th>
                    <th>Requested</th>
                    <th>Status</th>
                    <th className="num">Rows</th>
                    <th className="w1">
                      <span className="sr">Download</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id}>
                      <td>
                        <b className="cust">{jobLabel(job)}</b>
                      </td>
                      <td className="small">{describe(job.report)}</td>
                      <td className="small">{dubaiTime(job.createdAt)}</td>
                      <td>{jobStatus(job)}</td>
                      <td className="num">{job.rowCount ?? `~${job.estimatedRows}`}</td>
                      <td className="w1">{download(job)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="only-m mlist-wrap">
              <div className="mlist">
                {jobs.map((job) => (
                  <div key={job.id} className="mrow">
                    <div className="mrow-b">
                      <div className="mrow-t">
                        <b>{jobLabel(job)}</b>
                        <span className="small">
                          {job.rowCount ?? `~${job.estimatedRows}`} rows
                        </span>
                      </div>
                      <div className="meta">
                        <span>{describe(job.report)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{dubaiTime(job.createdAt)}</span>
                      </div>
                      <div className="row">{jobStatus(job)}</div>
                      {download(job) && <div className="mrow-a">{download(job)}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </section>
    </>
  );
}
