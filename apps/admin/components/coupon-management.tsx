"use client";
import { useState } from "react";
import { couponResponseSchema, couponsResponseSchema, type CouponResponse } from "@ih/contracts";
import {
  bpsToPercent,
  couponCreateCommand,
  couponSentence,
  couponStatusLabel,
  couponUpdateCommand,
  isoToLocal,
} from "../lib/coupons";
import { filsToAed, managementRequest } from "../lib/management";
import { ResourceNotice, useManagementResource } from "./management-resource";

type Tab = "live" | "trashed";
/** Percentage coupons only: there is no field for a fixed amount, a brand or a product. */
function CouponFields({ coupon }: { coupon: CouponResponse | null }) {
  return (
    <div className="form-grid">
      {!coupon && (
        <label>
          <span>Code *</span>
          <input name="code" required minLength={3} maxLength={32} autoCapitalize="characters" />
          <small className="muted">
            3 to 32 letters, digits, hyphens or underscores. Saved in capitals and cannot be changed
            later.
          </small>
        </label>
      )}
      <label>
        <span>Percentage off products *</span>
        <input
          name="percent"
          required
          inputMode="decimal"
          maxLength={6}
          placeholder="e.g. 15"
          defaultValue={coupon ? bpsToPercent(coupon.percentBps) : ""}
        />
      </label>
      <label>
        <span>Minimum spend on products (AED)</span>
        <input
          name="minimum"
          inputMode="decimal"
          maxLength={12}
          placeholder="No minimum"
          defaultValue={
            coupon && coupon.minSubtotalFils > 0 ? filsToAed(coupon.minSubtotalFils) : ""
          }
        />
      </label>
      <label>
        <span>Starts (your local time)</span>
        <input
          name="startsAt"
          type="datetime-local"
          defaultValue={isoToLocal(coupon?.startsAt ?? null)}
        />
      </label>
      <label>
        <span>Ends (your local time)</span>
        <input
          name="expiresAt"
          type="datetime-local"
          defaultValue={isoToLocal(coupon?.expiresAt ?? null)}
        />
      </label>
      <label>
        <span>Usage limit</span>
        <input
          name="usageLimit"
          inputMode="numeric"
          maxLength={7}
          placeholder="No limit"
          defaultValue={coupon?.usageLimit ?? ""}
        />
        <small className="muted">
          How many orders may hold this coupon at once. Blank is unlimited.
        </small>
      </label>
      <label>
        <span>Active</span>
        <input type="checkbox" name="active" defaultChecked={coupon?.active ?? false} />
      </label>
    </div>
  );
}
export function CouponManagement() {
  const [tab, setTab] = useState<Tab>("live");
  const [cursor, setCursor] = useState<string | null>(null);
  const coupons = useManagementResource(
    `/coupons?limit=25&trashed=${tab === "trashed"}` +
      (cursor ? "&after=" + encodeURIComponent(cursor) : ""),
    couponsResponseSchema,
  );
  const show = (next: Tab) => {
    setCursor(null);
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
  async function create(data: FormData, form: HTMLFormElement) {
    const outcome = await coupons.run((signal) =>
      managementRequest(
        "/coupons",
        couponResponseSchema,
        "POST",
        couponCreateCommand(data),
        signal,
      ),
    );
    if (outcome.ok) {
      form.reset();
      setCursor(null);
      coupons.reload();
    }
  }
  async function save(coupon: CouponResponse, data: FormData) {
    const outcome = await coupons.run((signal) =>
      managementRequest(
        "/coupons/" + coupon.id,
        couponResponseSchema,
        "PATCH",
        couponUpdateCommand(coupon.version, data),
        signal,
      ),
    );
    if (outcome.ok) replace(outcome.value);
  }
  async function move(coupon: CouponResponse, action: "trash" | "restore") {
    if (
      action === "trash" &&
      !window.confirm(
        `Move ${coupon.code} to Trash? It stops working at once. Orders that already used it keep their discount. You can restore it from Trash.`,
      )
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
    if (outcome.ok) drop(coupon.id);
  }
  return (
    <section className="management-card">
      <header className="card-heading">
        <h2>Discount codes</h2>
        <span className="badge">Percentage only · one code per order</span>
      </header>
      <p className="muted">
        A code takes a percentage off the products in an order. Delivery is never discounted, and a
        customer can use one code per order.
      </p>
      <div className="tab-list" role="tablist" aria-label="Discount code lists">
        <button
          type="button"
          role="tab"
          className="secondary-button"
          data-leave
          aria-selected={tab === "live"}
          onClick={() => show("live")}
        >
          Codes
        </button>
        <button
          type="button"
          role="tab"
          className="secondary-button"
          data-leave
          aria-selected={tab === "trashed"}
          onClick={() => show("trashed")}
        >
          Trash
        </button>
      </div>
      <ResourceNotice resource={coupons} />
      {coupons.data && (
        <>
          {tab === "live" && (
            <details>
              <summary>Add code</summary>
              <form
                data-unsaved="this new code"
                onSubmit={(e) => {
                  e.preventDefault();
                  void create(new FormData(e.currentTarget), e.currentTarget);
                }}
              >
                <fieldset disabled={coupons.disabled}>
                  <CouponFields coupon={null} />
                  <button className="primary-button" type="submit">
                    Add code
                  </button>
                </fieldset>
              </form>
            </details>
          )}
          {coupons.data.items.length === 0 && (
            <p className="muted">{tab === "live" ? "No discount codes yet." : "Trash is empty."}</p>
          )}
          <div className="record-list">
            {coupons.data.items.map((coupon) => (
              <form
                data-unsaved={coupon.code}
                className="record-card"
                key={`${coupon.id}-${coupon.version}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(coupon, new FormData(e.currentTarget));
                }}
              >
                <header className="card-heading">
                  <strong>{coupon.code}</strong>
                  <span className="badge">
                    {couponStatusLabel(coupon.status)} · v{coupon.version}
                  </span>
                </header>
                <p className="muted">{couponSentence(coupon)}</p>
                {tab === "live" ? (
                  <fieldset disabled={coupons.disabled}>
                    <CouponFields coupon={coupon} />
                    <div className="form-actions">
                      <button className="secondary-button" type="submit">
                        Save code
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void move(coupon, "trash")}
                      >
                        Move to Trash
                      </button>
                    </div>
                  </fieldset>
                ) : (
                  <fieldset disabled={coupons.disabled}>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void move(coupon, "restore")}
                    >
                      Restore as inactive
                    </button>
                  </fieldset>
                )}
              </form>
            ))}
          </div>
          <div className="form-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={!cursor || coupons.busy}
              onClick={() => setCursor(null)}
            >
              First page
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={!coupons.data.nextCursor || coupons.busy}
              onClick={() => setCursor(coupons.data!.nextCursor)}
            >
              Next page
            </button>
          </div>
        </>
      )}
    </section>
  );
}
