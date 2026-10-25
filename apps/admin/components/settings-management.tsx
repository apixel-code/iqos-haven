"use client";
import { confirmDialog } from "../lib/ui/confirm";
import {
  settingsResponseSchema,
  settingResponseSchema,
  type SettingsWriteRequest,
} from "@ih/contracts";
import { useState } from "react";
import { managementRequest, settingsCommand } from "../lib/management";
import { toast } from "../lib/ui/toast";
import { DeliveryManagement } from "./delivery-management";
import { Icon } from "./icons";
import { PageHead } from "./page-head";
import { Fields, ResourceNotice, useManagementResource, type Field } from "./management-resource";
const groups: Array<{
  key: SettingsWriteRequest["key"];
  title: string;
  help: string;
  fields: Field[];
}> = [
  {
    key: "store",
    title: "Store",
    help: "Use approved business details. Empty configuration has no saved defaults.",
    fields: [
      { name: "name", label: "Store name", required: true, max: 100 },
      {
        name: "domain",
        label: "Store domain",
        required: true,
        max: 253,
        help: "Lower-case hostname, without https:// or a path.",
      },
      { name: "legalName", label: "Business name", max: 200 },
    ],
  },
  {
    key: "contact",
    title: "Contact & social links",
    help: "Optional fields may be left blank. Phone numbers use international format, for example +971 followed by the approved number.",
    fields: [
      { name: "email", label: "Business email", kind: "email", max: 254 },
      { name: "phone", label: "Phone", max: 16 },
      { name: "address", label: "Address", kind: "textarea" },
      { name: "openingHours", label: "Opening hours" },
      { name: "footerNote", label: "Footer note" },
      ...["instagram", "tiktok", "facebook"].map((name) => ({
        name: "social." + name,
        label: name[0]!.toUpperCase() + name.slice(1),
        kind: "url" as const,
        help: "Full HTTPS URL without account credentials.",
      })),
    ],
  },
  {
    key: "whatsapp",
    title: "WhatsApp",
    help: "Configuration only. Saving templates does not send a message. Supported placeholders: {{store_name}}, {{order_number}}, {{status}}, {{total}}, {{support_phone}}.",
    fields: [
      { name: "number", label: "WhatsApp number", max: 16 },
      ...["orderConfirmation", "statusUpdate", "support"].map((name, index) => ({
        name: "templates." + name,
        label: ["Order confirmation", "Status update", "Support message"][index]!,
        kind: "textarea" as const,
        max: 2000,
      })),
    ],
  },
  {
    key: "notifications",
    title: "Notifications",
    help: "Saving preferences does not activate delivery: email also needs a verified sending domain. Low-stock alerts repeat for a product at most once a day. The daily summary (09:00 Dubai, the previous day's figures) goes only to recipients who are active staff allowed to see revenue.",
    fields: [
      { name: "inApp", label: "In-app notifications", kind: "checkbox" },
      { name: "newOrderEmail.enabled", label: "New-order email preference", kind: "checkbox" },
      { name: "lowStockEmail", label: "Low-stock email preference", kind: "checkbox" },
      { name: "dailySummaryEmail", label: "Daily summary email preference", kind: "checkbox" },
      {
        name: "recipients",
        label: "Email recipients",
        kind: "textarea",
        max: 2550,
        help: "Up to ten unique email addresses, separated by commas or new lines. Required when an email preference is enabled.",
      },
    ],
  },
];
type Tab = "general" | "contact" | "delivery" | "payments" | "notifications";
const TABS: ReadonlyArray<[Tab, string]> = [
  ["general", "General"],
  ["contact", "Contact & WhatsApp"],
  ["delivery", "Delivery"],
  ["payments", "Payments"],
  ["notifications", "Notifications"],
];
/** Which setting groups each prototype tab shows. */
const TAB_GROUPS: Record<Tab, ReadonlyArray<SettingsWriteRequest["key"]>> = {
  general: ["store"],
  contact: ["whatsapp", "contact"],
  delivery: [],
  payments: [],
  notifications: ["notifications"],
};

/**
 * Owner settings in the prototype's layout (`VIEWS.settings`, ADR 0097 V-A14): tabs for the
 * store, contact and WhatsApp, delivery (the same delivery screen as its own page), payments
 * and notifications. Each group saves on its own, with the version it was read at.
 */
export function SettingsManagement() {
  const resource = useManagementResource("/settings", settingsResponseSchema);
  const [tab, setTab] = useState<Tab>("general");
  const rows = (resource.data?.items ?? []).filter((row) => TAB_GROUPS[tab].includes(row.key));
  return (
    <>
      <PageHead title="Settings" sub="Owner-only store configuration." />
      <div className="tabs" role="tablist" aria-label="Settings">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === key}
            data-leave
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab !== "delivery" && <ResourceNotice resource={resource} compact />}
      {TAB_GROUPS[tab]
        .map((key) => rows.find((row) => row.key === key))
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .map((row) => {
          const group = groups.find((g) => g.key === row.key)!;
          const value =
            row.key === "notifications" && row.value
              ? { ...row.value, recipients: row.value.newOrderEmail.recipients.join("\n") }
              : row.value;
          async function save(data: FormData | null) {
            const outcome = await resource.run((signal) =>
              managementRequest(
                "/settings",
                settingResponseSchema,
                "PATCH",
                data
                  ? settingsCommand(row.key, row.version, data)
                  : { key: row.key, version: row.version, value: null },
                signal,
              ),
            );
            if (outcome.ok) {
              resource.setData((current) =>
                current
                  ? {
                      ...current,
                      items: current.items.map((item) =>
                        item.key === row.key ? outcome.value : item,
                      ),
                    }
                  : current,
              );
              toast(data ? `${group.title} saved` : `${group.title} cleared`);
            }
          }
          const whatsapp =
            row.key === "whatsapp" && row.value && typeof row.value.number === "string"
              ? row.value.number
              : null;
          return (
            <section
              className="card"
              key={`${row.key}-${row.version}`}
              aria-labelledby={`set-${row.key}`}
            >
              <form
                data-unsaved={group.title.toLowerCase()}
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(new FormData(e.currentTarget));
                }}
              >
                <div className="card-h">
                  <div>
                    <h2 id={`set-${row.key}`}>{group.title}</h2>
                    <p className="sub">{group.help}</p>
                  </div>
                  {row.value === null ? (
                    <span className="tag">Not configured</span>
                  ) : (
                    <span className="tag ok">
                      <Icon name="check" size="sm" />
                      Configured
                    </span>
                  )}
                </div>
                <fieldset className="card-b plain-fs" disabled={resource.disabled}>
                  <Fields fields={group.fields} value={value} />
                  {whatsapp && (
                    <a
                      className="btn btn-s btn-sm set-test"
                      href={`https://wa.me/${whatsapp.replace(/\D/g, "")}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Icon name="ext" size="sm" />
                      Test the WhatsApp number
                    </a>
                  )}
                </fieldset>
                <div className="card-f">
                  {row.value !== null && (
                    <button
                      type="button"
                      className="btn btn-ds"
                      disabled={resource.disabled}
                      onClick={() => {
                        void confirmDialog({
                          title: `Clear ${group.title.toLowerCase()} configuration?`,
                          ok: "Clear configuration",
                          danger: true,
                        }).then((ok) => {
                          if (ok) void save(null);
                        });
                      }}
                    >
                      Clear configuration
                    </button>
                  )}
                  <button className="btn btn-p" type="submit" disabled={resource.disabled}>
                    Save {group.title.toLowerCase()}
                  </button>
                </div>
              </form>
            </section>
          );
        })}
      {tab === "general" && (
        <section className="card" aria-labelledby="set-security">
          <div className="card-h">
            <h2 id="set-security">Sign-in & security</h2>
          </div>
          <div className="card-b form">
            <div className="row between set-line">
              <div>
                <b>Email and password</b>
                <p className="small muted">
                  Every admin account signs in with email and password. Sessions end after a period
                  without activity.
                </p>
              </div>
              <span className="tag ok">
                <Icon name="check" size="sm" />
                Active
              </span>
            </div>
            <div className="row between set-line">
              <div>
                <b>Two-step verification</b>
                <p className="small muted">A one-time code on sign-in. Not part of the launch.</p>
              </div>
              <span className="tag">Not at launch</span>
            </div>
          </div>
        </section>
      )}
      {tab === "delivery" && <DeliveryManagement embedded />}
      {tab === "payments" && (
        <>
          <section className="card" aria-labelledby="set-pay">
            <div className="card-h">
              <h2 id="set-pay">Payment methods</h2>
            </div>
            <div className="list an-list">
              <div className="li set-pay">
                <span className="dlg-ic tone-ok" aria-hidden="true">
                  <Icon name="cash" size="lg" />
                </span>
                <span className="li-b">
                  <b>Cash on Delivery</b>
                  <small>
                    Courier collects the order total in cash. The only method at launch.
                  </small>
                </span>
                <span className="tag ok">
                  <Icon name="check" size="sm" />
                  Active
                </span>
              </div>
              <div className="li set-pay is-later">
                <span className="dlg-ic" aria-hidden="true">
                  <Icon name="card" size="lg" />
                </span>
                <span className="li-b">
                  <b>Online card payments</b>
                  <small>Not part of the launch. Orders already record the payment method.</small>
                </span>
                <span className="tag">Not at launch</span>
              </div>
            </div>
          </section>
          <div className="note">
            <Icon name="info" />
            <p>Cash on Delivery can&apos;t be switched off while it is the only payment method.</p>
          </div>
        </>
      )}
    </>
  );
}
