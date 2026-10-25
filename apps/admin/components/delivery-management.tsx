"use client";
import { confirmDialog } from "../lib/ui/confirm";
import { toast } from "../lib/ui/toast";
import { useId, useState } from "react";
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
import { Icon } from "./icons";
import { Fields, ResourceNotice, useManagementResource } from "./management-resource";
import { Drawer } from "./overlays";
import { PageHead } from "./page-head";

type DeliveryAreaResponse = ReturnType<typeof deliveryAreaResponseSchema.parse>;

/**
 * Delivery (one flat fee across the UAE, BI-03) in the prototype's layout (Settings › Delivery,
 * ADR 0097 V-A14): the charge card, and the areas as a list with an active switch, edited in a
 * drawer. `embedded` leaves out the page head inside Settings.
 */
export function DeliveryManagement({ embedded = false }: { embedded?: boolean }) {
  const configuration = useManagementResource(
    "/delivery-areas/configuration",
    deliveryConfigurationResponseSchema,
  );
  const [cursors, setCursors] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [show, setShow] = useState<"all" | "on" | "off">("all");
  const [editing, setEditing] = useState<DeliveryAreaResponse | "new" | null>(null);
  const cursor = cursors.at(-1);
  const areas = useManagementResource(
    "/delivery-areas?limit=100" + (cursor ? "&after=" + encodeURIComponent(cursor) : ""),
    deliveryAreasResponseSchema,
  );
  const row = configuration.data;
  const all = areas.data?.items ?? [];
  const items = all.filter(
    (area) =>
      (!q.trim() || area.name.toLowerCase().includes(q.trim().toLowerCase())) &&
      (show === "all" || (show === "on" ? area.active : !area.active)),
  );
  const replace = (next: DeliveryAreaResponse) =>
    areas.setData((current) =>
      current
        ? { ...current, items: current.items.map((item) => (item.id === next.id ? next : item)) }
        : current,
    );
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
    if (outcome.ok) {
      configuration.setData(outcome.value);
      toast(data ? "Delivery charge saved" : "Delivery charge cleared");
    }
  }
  async function update(area: DeliveryAreaResponse, name: string, active: boolean) {
    const outcome = await areas.run((signal) =>
      managementRequest(
        "/delivery-areas/" + area.id,
        deliveryAreaResponseSchema,
        "PATCH",
        validate(deliveryAreaUpdateRequestSchema, { version: area.version, name, active }),
        signal,
      ),
    );
    if (outcome.ok) replace(outcome.value);
    return outcome.ok;
  }
  const fee = row?.value ? `AED ${filsToAed(row.value.flatFeeFils)}` : null;
  return (
    <>
      {!embedded && (
        <PageHead
          title="Delivery"
          sub="One delivery charge for every active area across the UAE."
        />
      )}
      <section className="card" aria-labelledby="del-charge">
        <form
          data-unsaved="the delivery charge"
          key={row?.version ?? "loading"}
          onSubmit={(e) => {
            e.preventDefault();
            void saveConfiguration(new FormData(e.currentTarget));
          }}
        >
          <div className="card-h">
            <div>
              <h2 id="del-charge">Delivery charge</h2>
              <p className="sub">
                {row?.value
                  ? "One charge for every active area."
                  : "Not configured. Obtain the approved fee and delivery promise before saving."}{" "}
                Free delivery is disabled.
              </p>
            </div>
            <span className="tag">One fee across the UAE</span>
          </div>
          <div className="card-b">
            <ResourceNotice resource={configuration} compact />
            {row && (
              <fieldset className="plain-fs" disabled={configuration.disabled}>
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
              </fieldset>
            )}
          </div>
          {row && (
            <div className="card-f">
              {row.value && (
                <button
                  type="button"
                  className="btn btn-ds"
                  disabled={configuration.disabled}
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
              <button className="btn btn-p" type="submit" disabled={configuration.disabled}>
                Save delivery charge
              </button>
            </div>
          )}
        </form>
      </section>
      <section className="card del-areas" aria-labelledby="del-areas">
        <div className="card-h">
          <div>
            <h2 id="del-areas">
              Delivery areas{" "}
              {areas.data && (
                <span className="sub">
                  · {all.filter((area) => area.active).length} of {all.length} active
                </span>
              )}
            </h2>
            <p className="sub">
              Add approved coverage only. Inactive areas cannot be chosen at checkout. The code and
              emirate stay fixed; deactivate an area to keep its history.
            </p>
          </div>
          <button type="button" className="btn btn-s btn-sm" onClick={() => setEditing("new")}>
            <Icon name="plus" size="sm" />
            Add area
          </button>
        </div>
        <div className="card-b del-tools">
          <div className="toolbar">
            <div className="search">
              <Icon name="search" />
              <label className="sr" htmlFor="del-q">
                Search areas
              </label>
              <input
                id="del-q"
                type="search"
                placeholder="Search areas"
                value={q}
                maxLength={100}
                onChange={(event) => setQ(event.target.value)}
              />
            </div>
            <div className="seg" role="group" aria-label="Show areas">
              {(
                [
                  ["all", "All"],
                  ["on", "Active"],
                  ["off", "Inactive"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={show === value}
                  onClick={() => setShow(value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <ResourceNotice resource={areas} compact />
        </div>
        {areas.data &&
          (items.length ? (
            <div className="list del-list">
              {items.map((area) => (
                <div className="li del-row" key={`${area.id}-${area.version}`}>
                  <span className="li-b">
                    <b className={area.active ? undefined : "muted"}>{area.name}</b>
                    <small>
                      <span className="mono">{area.code}</span> · {EMIRATE_NAMES[area.emirate]} ·{" "}
                      {area.active ? (fee ?? "Charge not set") : "Not available at checkout"}
                    </small>
                  </span>
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={area.active}
                      disabled={areas.disabled}
                      aria-label={`${area.name} active`}
                      onChange={(event) => {
                        // Read the new state now: the box shows the saved state afterwards.
                        const active = event.target.checked;
                        void update(area, area.name, active).then((ok) => {
                          if (ok)
                            toast(`${area.name} ${active ? "is available" : "is off"} at checkout`);
                        });
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="ibtn"
                    aria-label={`Edit ${area.name}`}
                    onClick={() => setEditing(area)}
                  >
                    <Icon name="edit" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty dash-empty">
              <div className="ic">
                <Icon name="pin" />
              </div>
              <h3>{all.length ? "No areas match" : "No delivery areas yet"}</h3>
              <p>
                {all.length
                  ? "Try another name, or add the area."
                  : "Add the approved areas. No prototype areas were imported."}
              </p>
            </div>
          ))}
        {areas.data && (cursors.length > 0 || areas.data.nextCursor) && (
          <div className="tbl-f">
            <span>Up to 100 areas per page</span>
            <div className="pager">
              <button
                type="button"
                aria-label="Previous page"
                disabled={cursors.length === 0 || areas.busy}
                onClick={() => setCursors((value) => value.slice(0, -1))}
              >
                <Icon name="cl" size="sm" />
              </button>
              <button type="button" aria-current="page" aria-label={`Page ${cursors.length + 1}`}>
                {cursors.length + 1}
              </button>
              <button
                type="button"
                aria-label="Next page"
                disabled={!areas.data.nextCursor || areas.busy}
                onClick={() => setCursors((value) => [...value, areas.data!.nextCursor!])}
              >
                <Icon name="cr" size="sm" />
              </button>
            </div>
          </div>
        )}
      </section>
      {editing && (
        <AreaDrawer
          key={editing === "new" ? "new" : `${editing.id}-${editing.version}`}
          area={editing === "new" ? null : editing}
          resource={areas}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null);
            toast(created ? `${saved.name} added` : `${saved.name} saved`);
            if (created) {
              setCursors([]);
              areas.reload();
            } else replace(saved);
          }}
        />
      )}
    </>
  );
}

/** Add an area (emirate and code fixed from then on) or rename one and switch it on or off. */
function AreaDrawer({
  area,
  resource,
  onClose,
  onSaved,
}: {
  area: DeliveryAreaResponse | null;
  resource: Pick<
    ReturnType<typeof useManagementResource>,
    "run" | "disabled" | "message" | "busy" | "denied" | "reload"
  >;
  onClose: () => void;
  onSaved: (saved: DeliveryAreaResponse, created: boolean) => void;
}) {
  const form = useId();
  return (
    <Drawer
      open
      onClose={onClose}
      title={area ? `Edit ${area.name}` : "Add area"}
      sub={area ? `${area.code} · ${EMIRATE_NAMES[area.emirate]}` : "Approved UAE coverage"}
      foot={
        <>
          <button type="button" className="btn btn-s" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form={form} className="btn btn-p" disabled={resource.disabled}>
            {area ? "Save area" : "Add area"}
          </button>
        </>
      }
    >
      <form
        id={form}
        className="form"
        data-unsaved={area ? "this delivery area" : "this new area"}
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const outcome = await resource.run((signal) =>
            area
              ? managementRequest(
                  "/delivery-areas/" + area.id,
                  deliveryAreaResponseSchema,
                  "PATCH",
                  validate(deliveryAreaUpdateRequestSchema, {
                    version: area.version,
                    name: String(data.get("name") ?? "").trim(),
                    active: data.get("active") === "on",
                  }),
                  signal,
                )
              : managementRequest(
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
          if (outcome.ok) onSaved(outcome.value, !area);
        }}
      >
        <ResourceNotice resource={resource} compact />
        <fieldset className="plain-fs form" disabled={resource.disabled}>
          {!area && (
            <div className="field">
              <label className="label" htmlFor={`${form}-emirate`}>
                <span>
                  Emirate{" "}
                  <span className="req" aria-hidden="true">
                    *
                  </span>
                </span>
              </label>
              <select
                id={`${form}-emirate`}
                className="select"
                name="emirate"
                defaultValue="dubai"
                required
              >
                {UAE_EMIRATES.map((emirate) => (
                  <option key={emirate} value={emirate}>
                    {EMIRATE_NAMES[emirate]}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Fields
            fields={[
              ...(area
                ? []
                : [
                    {
                      name: "code",
                      label: "Stable area code",
                      required: true,
                      max: 64,
                      help: "Lower-case letters, numbers, underscores or hyphens; starts with a letter.",
                    },
                  ]),
              { name: "name", label: "Area name", required: true, max: 100 },
              { name: "active", label: "Approved and active", kind: "checkbox" as const },
            ]}
            value={area}
          />
        </fieldset>
      </form>
    </Drawer>
  );
}
