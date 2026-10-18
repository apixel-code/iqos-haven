"use client";
import { confirmDialog } from "../lib/ui/confirm";
import { useState } from "react";
import {
  deliveryConfigurationResponseSchema,
  deliveryAreaResponseSchema,
  deliveryAreaCreateRequestSchema,
  deliveryAreaUpdateRequestSchema,
  deliveryAreasResponseSchema,
  EMIRATE_NAMES,
  UAE_EMIRATES,
} from "@ih/contracts";
import { deliveryCommand, filsToAed, managementRequest, validate } from "../lib/management";
import { Fields, ResourceNotice, useManagementResource } from "./management-resource";
export function DeliveryManagement() {
  const configuration = useManagementResource(
    "/delivery-areas/configuration",
    deliveryConfigurationResponseSchema,
  );
  const [cursor, setCursor] = useState<string | null>(null);
  const areas = useManagementResource(
    "/delivery-areas?limit=25" + (cursor ? "&after=" + encodeURIComponent(cursor) : ""),
    deliveryAreasResponseSchema,
  );
  const row = configuration.data;
  async function saveConfiguration(data: FormData | null) {
    if (!row) return;
    const outcome = await configuration.run((signal) =>
      managementRequest(
        "/delivery-areas/configuration",
        deliveryConfigurationResponseSchema,
        "PATCH",
        data ? deliveryCommand(row.version, data) : { version: row.version, value: null },
        signal,
      ),
    );
    if (outcome.ok) configuration.setData(outcome.value);
  }
  async function create(data: FormData, form: HTMLFormElement) {
    const outcome = await areas.run((signal) =>
      managementRequest(
        "/delivery-areas",
        deliveryAreaResponseSchema,
        "POST",
        validate(deliveryAreaCreateRequestSchema, {
          code: String(data.get("code") ?? "").trim(),
          emirate: String(data.get("emirate") ?? ""),
          name: String(data.get("name") ?? "").trim(),
          active: data.get("active") === "on",
        }),
        signal,
      ),
    );
    if (outcome.ok) {
      form.reset();
      setCursor(null);
      areas.reload();
    }
  }
  return (
    <>
      <section className="management-card">
        <header className="card-heading">
          <h2>Delivery charge</h2>
          <span className="badge">One fee across the UAE</span>
        </header>
        <ResourceNotice resource={configuration} />
        {row && (
          <form
            data-unsaved="the delivery charge"
            key={row.version}
            onSubmit={(e) => {
              e.preventDefault();
              void saveConfiguration(new FormData(e.currentTarget));
            }}
          >
            <p className="muted">
              {row.value
                ? "One charge for every active area."
                : "Not configured. Obtain the approved fee and delivery promise before saving."}{" "}
              Free delivery is disabled.
            </p>
            <fieldset disabled={configuration.disabled}>
              <Fields
                fields={[
                  {
                    name: "fee",
                    label: "Standard charge (AED)",
                    required: true,
                    max: 12,
                    help: "Up to two decimal places; zero must be explicitly approved.",
                  },
                  { name: "etaText", label: "Delivery promise", required: true, max: 500 },
                ]}
                value={
                  row.value
                    ? { fee: filsToAed(row.value.flatFeeFils), etaText: row.value.etaText }
                    : null
                }
              />
              <div className="form-actions">
                <button className="primary-button" type="submit">
                  Save delivery charge
                </button>
                {row.value && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      void confirmDialog({
                        title: "Clear delivery charge and promise?",
                        body: "Checkout stays closed to new orders until delivery is set again.",
                        ok: "Clear configuration",
                        danger: true,
                      }).then((ok) => {
                        if (ok) void saveConfiguration(null);
                      });
                    }}
                  >
                    Clear configuration
                  </button>
                )}
              </div>
            </fieldset>
          </form>
        )}
      </section>
      <section className="management-card">
        <header className="card-heading">
          <h2>Delivery areas</h2>
          <span className="badge">Approved UAE coverage</span>
        </header>
        <p className="muted">
          Add approved coverage only. Inactive areas cannot be selected at checkout. The code and
          emirate stay fixed; deactivate areas to preserve history.
        </p>
        <ResourceNotice resource={areas} />
        {areas.data && (
          <>
            <details>
              <summary>Add area</summary>
              <form
                data-unsaved="this new area"
                onSubmit={(e) => {
                  e.preventDefault();
                  void create(new FormData(e.currentTarget), e.currentTarget);
                }}
              >
                <fieldset disabled={areas.disabled}>
                  <label>
                    <span>Emirate *</span>
                    <select name="emirate" defaultValue="dubai" required>
                      {UAE_EMIRATES.map((emirate) => (
                        <option key={emirate} value={emirate}>
                          {EMIRATE_NAMES[emirate]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <Fields
                    fields={[
                      {
                        name: "code",
                        label: "Stable area code",
                        required: true,
                        max: 64,
                        help: "Lower-case letters, numbers, underscores or hyphens; starts with a letter.",
                      },
                      { name: "name", label: "Area name", required: true, max: 100 },
                      { name: "active", label: "Approved and active", kind: "checkbox" },
                    ]}
                    value={null}
                  />
                  <button className="primary-button" type="submit">
                    Add area
                  </button>
                </fieldset>
              </form>
            </details>
            {areas.data.items.length === 0 && (
              <p className="muted">No areas on this page. No prototype areas were imported.</p>
            )}
            <div className="record-list">
              {areas.data.items.map((area) => (
                <form
                  data-unsaved="this delivery area"
                  className="record-card"
                  key={`${area.id}-${area.version}`}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const data = new FormData(e.currentTarget);
                    const outcome = await areas.run((signal) =>
                      managementRequest(
                        "/delivery-areas/" + area.id,
                        deliveryAreaResponseSchema,
                        "PATCH",
                        validate(deliveryAreaUpdateRequestSchema, {
                          version: area.version,
                          name: String(data.get("name") ?? "").trim(),
                          active: data.get("active") === "on",
                        }),
                        signal,
                      ),
                    );
                    if (outcome.ok)
                      areas.setData((current) =>
                        current
                          ? {
                              ...current,
                              items: current.items.map((item) =>
                                item.id === area.id ? outcome.value : item,
                              ),
                            }
                          : current,
                      );
                  }}
                >
                  <header className="card-heading">
                    <strong>
                      {area.code} · {EMIRATE_NAMES[area.emirate]}
                    </strong>
                    <span className="badge">
                      {area.active ? "Active" : "Inactive"} · v{area.version}
                    </span>
                  </header>
                  <fieldset disabled={areas.disabled}>
                    <Fields
                      fields={[
                        { name: "name", label: "Area name", required: true, max: 100 },
                        { name: "active", label: "Approved and active", kind: "checkbox" },
                      ]}
                      value={area}
                    />
                    <button className="secondary-button" type="submit">
                      Save area
                    </button>
                  </fieldset>
                </form>
              ))}
            </div>
            <div className="form-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={!cursor || areas.busy}
                onClick={() => setCursor(null)}
              >
                First page
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={!areas.data.nextCursor || areas.busy}
                onClick={() => setCursor(areas.data!.nextCursor)}
              >
                Next page
              </button>
            </div>
          </>
        )}
      </section>
    </>
  );
}
