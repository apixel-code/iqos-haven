"use client";
import { confirmDialog } from "../lib/ui/confirm";
import { toast } from "../lib/ui/toast";
import { useId, useState } from "react";
import { couponResponseSchema, couponsResponseSchema, type CouponResponse } from "@ih/contracts";
import {
  bpsToPercent,
  couponActiveCommand,
  couponCreateCommand,
  couponGroup,
  couponPreview,
  couponSentence,
  couponStatusLabel,
  couponUpdateCommand,
  generateCouponCode,
  isoToLocal,
  localToIso,
  type CouponGroup,
} from "../lib/coupons";
import { filsToAed, managementRequest } from "../lib/management";
import { when } from "../lib/orders";
import { Icon } from "./icons";
import { ResourceNotice, useManagementResource } from "./management-resource";
import { Drawer } from "./overlays";
import { PageHead } from "./page-head";

type Tab = "all" | CouponGroup | "trashed";
const TABS: ReadonlyArray<[Tab, string]> = [
  ["all", "All"],
  ["active", "Active"],
  ["inactive", "Inactive"],
  ["expired", "Expired"],
  ["trashed", "Trash"],
];
const DAY = 86_400_000;

/** The prototype's coupon status tag (`stTag`), with the finer server status in its text. */
function StatusTag({ coupon }: { coupon: CouponResponse }) {
  const group = couponGroup(coupon.status);
  return group === "active" ? (
    <span className="tag ok">
      <Icon name="check" size="sm" />
      {couponStatusLabel(coupon.status)}
    </span>
  ) : group === "expired" ? (
    <span className="tag out">
      <Icon name="clock" size="sm" />
      {couponStatusLabel(coupon.status)}
    </span>
  ) : (
    <span className="tag">
      <Icon name="eye-off" size="sm" />
      {couponStatusLabel(coupon.status)}
    </span>
  );
}

/** The prototype's validity line (`left`): starts, ends, days left or ended. */
function Window({ coupon, now }: { coupon: CouponResponse; now: number }) {
  if (coupon.startsAt && new Date(coupon.startsAt).getTime() > now)
    return <span>Starts {when(coupon.startsAt)}</span>;
  if (!coupon.expiresAt) return <span className="muted">No end date</span>;
  const ends = new Date(coupon.expiresAt).getTime();
  if (ends <= now) return <span>Ended {when(coupon.expiresAt)}</span>;
  const days = Math.ceil((ends - now) / DAY);
  if (days <= 1) return <span className="warn-t">Ends {when(coupon.expiresAt)}</span>;
  if (days <= 14) return <span className="warn-t">{days} days left</span>;
  return <span>Until {when(coupon.expiresAt)}</span>;
}

function Used({ coupon }: { coupon: CouponResponse }) {
  return (
    <>
      {coupon.activeRedemptions}
      {coupon.usageLimit !== null && <span className="muted"> / {coupon.usageLimit}</span>}
    </>
  );
}

/**
 * Discount codes (step 72) in the prototype's layout (`VIEWS.discounts`, ADR 0097 V-A9):
 * percentage coupons only, one per order, delivery never discounted. A coupon is created or
 * edited in the drawer; the list's switch turns one on or off with its terms unchanged.
 */
export function CouponManagement() {
  const [tab, setTab] = useState<Tab>("all");
  const [cursors, setCursors] = useState<string[]>([]);
  const [editing, setEditing] = useState<CouponResponse | "new" | null>(null);
  // "Days left" is read against the time the screen opened.
  const [now] = useState(() => Date.now());
  const trash = tab === "trashed";
  const cursor = cursors.at(-1);
  // Coupons are few: a page of 100 holds them all, so the status tabs filter it here.
  const coupons = useManagementResource(
    `/coupons?limit=100&trashed=${trash}` + (cursor ? "&after=" + encodeURIComponent(cursor) : ""),
    couponsResponseSchema,
  );
  const all = coupons.data?.items ?? [];
  const items = trash || tab === "all" ? all : all.filter((c) => couponGroup(c.status) === tab);
  const count = (key: Tab) =>
    key === "all" ? all.length : all.filter((c) => couponGroup(c.status) === key).length;
  const show = (next: Tab) => {
    if (trash !== (next === "trashed")) setCursors([]);
    setTab(next);
  };
  const replace = (row: CouponResponse) =>
    coupons.setData((current) =>
      current
        ? { ...current, items: current.items.map((item) => (item.id === row.id ? row : item)) }
        : current,
    );
  const drop = (id: string) =>
    coupons.setData((current) =>
      current ? { ...current, items: current.items.filter((item) => item.id !== id) } : current,
    );
  async function setActive(coupon: CouponResponse, active: boolean) {
    const outcome = await coupons.run((signal) =>
      managementRequest(
        "/coupons/" + coupon.id,
        couponResponseSchema,
        "PATCH",
        couponActiveCommand(coupon, active),
        signal,
      ),
    );
    if (outcome.ok) {
      replace(outcome.value);
      toast(`${coupon.code} ${active ? "activated" : "deactivated"}`);
    }
  }
  async function move(coupon: CouponResponse, action: "trash" | "restore") {
    if (
      action === "trash" &&
      !(await confirmDialog({
        title: `Move ${coupon.code} to Trash?`,
        body: "It stops working at once. Orders that already used it keep their discount. You can restore it from Trash.",
        ok: "Move to Trash",
        danger: true,
      }))
    )
      return;
    const outcome = await coupons.run((signal) =>
      managementRequest(
        `/coupons/${coupon.id}/${action}`,
        couponResponseSchema,
        "POST",
        { version: coupon.version },
        signal,
      ),
    );
    if (outcome.ok) {
      drop(coupon.id);
      toast(action === "trash" ? `${coupon.code} moved to Trash` : `${coupon.code} restored`);
    }
  }
  const canSwitch = (coupon: CouponResponse) => couponGroup(coupon.status) !== "expired";
  const switchFor = (coupon: CouponResponse, text?: string) =>
    canSwitch(coupon) && (
      <label className="switch">
        <input
          type="checkbox"
          checked={coupon.active}
          disabled={coupons.disabled}
          aria-label={`${coupon.code} active`}
          onChange={(event) => void setActive(coupon, event.target.checked)}
        />
        {text && <span className="small">{text}</span>}
      </label>
    );
  const actions = (coupon: CouponResponse) =>
    trash ? (
      <button
        type="button"
        className="btn btn-s btn-sm"
        disabled={coupons.disabled}
        onClick={() => void move(coupon, "restore")}
      >
        <Icon name="restore" size="sm" />
        Restore as inactive
      </button>
    ) : (
      <>
        <button
          type="button"
          className="ibtn"
          aria-label={`Edit ${coupon.code}`}
          onClick={() => setEditing(coupon)}
        >
          <Icon name="edit" />
        </button>
        <button
          type="button"
          className="ibtn"
          aria-label={`Move ${coupon.code} to Trash`}
          disabled={coupons.disabled}
          onClick={() => void move(coupon, "trash")}
        >
          <Icon name="trash" />
        </button>
      </>
    );
  return (
    <>
      <PageHead
        title="Discounts"
        sub="Percentage coupon codes customers enter at checkout."
        actions={
          <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
            <Icon name="plus" />
            New coupon
          </button>
        }
      />
      <div className="tabs" role="tablist" aria-label="Discount code lists">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === key}
            onClick={() => show(key)}
          >
            {key === "trashed" && <Icon name="trash" size="sm" />}
            {label}
            {coupons.data && !trash && key !== "trashed" && <span className="c">{count(key)}</span>}
          </button>
        ))}
      </div>
      <ResourceNotice resource={coupons} compact />
      {coupons.data &&
        (items.length === 0 ? (
          <div className="card">
            <div className="empty">
              <div className="ic">
                <Icon name={trash ? "trash" : "percent"} />
              </div>
              <h3>{trash ? "Trash is empty" : "No coupons here"}</h3>
              <p>
                {trash
                  ? "Coupons moved to Trash can be restored from here."
                  : "Create a percentage coupon with a minimum order and an end date."}
              </p>
              {!trash && (
                <div className="row">
                  <button type="button" className="btn btn-p" onClick={() => setEditing("new")}>
                    <Icon name="plus" />
                    New coupon
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="tbl-wrap only-d">
              <div className="tbl-scroll">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th className="num">Discount</th>
                      <th className="num">Min. order</th>
                      <th>Validity</th>
                      <th className="num">Used</th>
                      <th>Status</th>
                      <th className="w1">
                        <span className="sr">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((coupon) => (
                      <tr key={`${coupon.id}-${coupon.version}`} className="coupon-row">
                        <td>
                          <span className="coupon">{coupon.code}</span>
                        </td>
                        <td className="num">
                          <b className="cust">{bpsToPercent(coupon.percentBps)}%</b>
                        </td>
                        <td className="num">
                          {coupon.minSubtotalFils > 0 ? (
                            `AED ${filsToAed(coupon.minSubtotalFils)}`
                          ) : (
                            <span className="muted">None</span>
                          )}
                        </td>
                        <td className="small">
                          <Window coupon={coupon} now={now} />
                        </td>
                        <td className="num">
                          <Used coupon={coupon} />
                        </td>
                        <td>
                          <StatusTag coupon={coupon} />
                        </td>
                        <td className="w1">
                          <div className="row nowrap-row tight">
                            {!trash && switchFor(coupon)}
                            {actions(coupon)}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {/* Phones: the prototype's coupon rows in place of the table. */}
            <div className="only-m">
              <div className="mlist">
                {items.map((coupon) => (
                  <div key={`${coupon.id}-${coupon.version}`} className="mrow coupon-row">
                    <div className="mrow-b">
                      <div className="mrow-t">
                        <span className="coupon">{coupon.code}</span>
                        <StatusTag coupon={coupon} />
                      </div>
                      <div className="mrow-t">
                        <b>{bpsToPercent(coupon.percentBps)}% off products</b>
                      </div>
                      <div className="meta">
                        <span>
                          {coupon.minSubtotalFils > 0
                            ? `Min. AED ${filsToAed(coupon.minSubtotalFils)}`
                            : "No minimum"}
                        </span>
                        <span aria-hidden="true">·</span>
                        <Window coupon={coupon} now={now} />
                        <span aria-hidden="true">·</span>
                        <span>
                          Used <Used coupon={coupon} />
                        </span>
                      </div>
                      <div className="mrow-a">
                        {!trash && switchFor(coupon, "Active")}
                        {actions(coupon)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {(cursors.length > 0 || coupons.data.nextCursor) && (
              <div className="tbl-wrap">
                <div className="tbl-f">
                  <span>Showing up to 100 coupons per page</span>
                  <div className="pager">
                    <button
                      type="button"
                      aria-label="Previous page"
                      disabled={cursors.length === 0 || coupons.busy}
                      onClick={() => setCursors((value) => value.slice(0, -1))}
                    >
                      <Icon name="cl" size="sm" />
                    </button>
                    <button
                      type="button"
                      aria-current="page"
                      aria-label={`Page ${cursors.length + 1}`}
                    >
                      {cursors.length + 1}
                    </button>
                    <button
                      type="button"
                      aria-label="Next page"
                      disabled={!coupons.data.nextCursor || coupons.busy}
                      onClick={() => setCursors((value) => [...value, coupons.data!.nextCursor!])}
                    >
                      <Icon name="cr" size="sm" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        ))}
      <p className="help help-i">
        <Icon name="info" size="sm" /> A coupon applies only while it is active, within its dates,
        under its usage limit, and when the products in the order meet the minimum. One coupon per
        order; delivery is never discounted.
      </p>
      {editing && (
        <CouponDrawer
          key={editing === "new" ? "new" : `${editing.id}-${editing.version}`}
          coupon={editing === "new" ? null : editing}
          resource={coupons}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null);
            toast(created ? `${saved.code} created` : `${saved.code} saved`);
            if (created) {
              setCursors([]);
              coupons.reload();
            } else replace(saved);
          }}
        />
      )}
    </>
  );
}

/** The prototype's coupon drawer (`cpBody`), with the live sentence (`cpSentence`). */
function CouponDrawer({
  coupon,
  resource,
  onClose,
  onSaved,
}: {
  coupon: CouponResponse | null;
  /** The list's resource: the save runs through it, and its notice shows here too. */
  resource: Pick<
    ReturnType<typeof useManagementResource>,
    "run" | "disabled" | "message" | "busy" | "denied" | "reload"
  >;
  onClose: () => void;
  onSaved: (saved: CouponResponse, created: boolean) => void;
}) {
  const form = useId();
  const [code, setCode] = useState(coupon?.code ?? "");
  const [percent, setPercent] = useState(coupon ? bpsToPercent(coupon.percentBps) : "10");
  const [minimum, setMinimum] = useState(
    coupon && coupon.minSubtotalFils > 0 ? filsToAed(coupon.minSubtotalFils) : "",
  );
  const [ends, setEnds] = useState(isoToLocal(coupon?.expiresAt ?? null));
  let endLabel: string | null = null;
  try {
    const iso = localToIso(ends);
    endLabel = iso ? when(iso) : null;
  } catch {
    endLabel = null;
  }
  const preview = couponPreview({ code, percent, minimum, ends: endLabel });
  return (
    <Drawer
      open
      onClose={onClose}
      title={coupon ? `Edit ${coupon.code}` : "New coupon"}
      sub="Percentage discount"
      foot={
        <>
          <button type="button" className="btn btn-s" onClick={onClose}>
            Cancel
          </button>
          {coupon ? (
            <button type="submit" form={form} className="btn btn-p" disabled={resource.disabled}>
              Save changes
            </button>
          ) : (
            <>
              <button type="submit" form={form} className="btn btn-s" disabled={resource.disabled}>
                Save inactive
              </button>
              <button
                type="submit"
                form={form}
                name="active"
                value="on"
                className="btn btn-p"
                disabled={resource.disabled}
              >
                <Icon name="check" />
                Create & activate
              </button>
            </>
          )}
        </>
      }
    >
      <form
        id={form}
        className="form"
        data-unsaved={coupon ? coupon.code : "this new coupon"}
        onSubmit={async (e) => {
          e.preventDefault();
          // The pressed button decides a new coupon's state ("Create & activate").
          const data = new FormData(e.currentTarget, e.nativeEvent.submitter);
          const outcome = await resource.run((signal) =>
            coupon
              ? managementRequest(
                  "/coupons/" + coupon.id,
                  couponResponseSchema,
                  "PATCH",
                  couponUpdateCommand(coupon.version, data),
                  signal,
                )
              : managementRequest(
                  "/coupons",
                  couponResponseSchema,
                  "POST",
                  couponCreateCommand(data),
                  signal,
                ),
          );
          if (outcome.ok) onSaved(outcome.value, !coupon);
        }}
      >
        <ResourceNotice resource={resource} compact />
        <fieldset className="plain-fs form" disabled={resource.disabled}>
          {coupon ? (
            <div className="row coupon-head">
              <span className="coupon">{coupon.code}</span>
              <StatusTag coupon={coupon} />
              {/* Edits keep the coupon's on/off state; the list's switch changes it. */}
              {coupon.active && <input type="hidden" name="active" value="on" />}
            </div>
          ) : (
            <div className="field">
              <label className="label" htmlFor={`${form}-code`}>
                <span>
                  Coupon code{" "}
                  <span className="req" aria-hidden="true">
                    *
                  </span>
                </span>
              </label>
              <div className="row nowrap-row">
                <input
                  id={`${form}-code`}
                  className="input mono coupon-input"
                  name="code"
                  required
                  minLength={3}
                  maxLength={32}
                  autoCapitalize="characters"
                  autoComplete="off"
                  placeholder="WEEKEND12"
                  data-autofocus=""
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                />
                <button
                  type="button"
                  className="btn btn-s"
                  onClick={() => setCode(generateCouponCode())}
                >
                  <Icon name="wand" size="sm" />
                  Generate
                </button>
              </div>
              <p className="help">
                3 to 32 letters, digits, hyphens or underscores. Customers type it at checkout; it
                cannot be changed later.
              </p>
            </div>
          )}
          <div className="fgrid c2 even">
            <div className="field">
              <label className="label" htmlFor={`${form}-pct`}>
                <span>
                  Percentage off{" "}
                  <span className="req" aria-hidden="true">
                    *
                  </span>
                </span>
              </label>
              <div className="affix">
                <input
                  id={`${form}-pct`}
                  className="input"
                  name="percent"
                  required
                  inputMode="decimal"
                  maxLength={6}
                  value={percent}
                  onChange={(e) => setPercent(e.target.value)}
                />
                <span>%</span>
              </div>
            </div>
            <div className="field">
              <label className="label" htmlFor={`${form}-min`}>
                Minimum order
              </label>
              <div className="affix">
                <span>AED</span>
                <input
                  id={`${form}-min`}
                  className="input"
                  name="minimum"
                  inputMode="decimal"
                  maxLength={12}
                  placeholder="0"
                  value={minimum}
                  onChange={(e) => setMinimum(e.target.value)}
                />
              </div>
              <p className="help">Products only. Blank means no minimum.</p>
            </div>
          </div>
          <div className="fgrid c2 even">
            <div className="field">
              <label className="label" htmlFor={`${form}-start`}>
                <span>
                  Starts <span className="opt">Optional</span>
                </span>
              </label>
              <input
                id={`${form}-start`}
                className="input"
                name="startsAt"
                type="datetime-local"
                defaultValue={isoToLocal(coupon?.startsAt ?? null)}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor={`${form}-end`}>
                <span>
                  Ends <span className="opt">Optional</span>
                </span>
              </label>
              <input
                id={`${form}-end`}
                className="input"
                name="expiresAt"
                type="datetime-local"
                value={ends}
                onChange={(e) => setEnds(e.target.value)}
              />
            </div>
          </div>
          <p className="help">Dates and times are in this device&apos;s time zone.</p>
          <div className="field">
            <label className="label" htmlFor={`${form}-limit`}>
              <span>
                Usage limit <span className="opt">Optional</span>
              </span>
            </label>
            <input
              id={`${form}-limit`}
              className="input"
              name="usageLimit"
              inputMode="numeric"
              maxLength={7}
              placeholder="No limit"
              defaultValue={coupon?.usageLimit ?? ""}
            />
            <p className="help">How many orders may hold this coupon at once.</p>
          </div>
          <div className="note info" aria-live="polite">
            <Icon name="percent" />
            <p>{preview ?? "Enter a percentage such as 15 or 12.5 to see what the coupon does."}</p>
          </div>
          {coupon && <p className="help">{couponSentence(coupon)}</p>}
        </fieldset>
      </form>
    </Drawer>
  );
}
