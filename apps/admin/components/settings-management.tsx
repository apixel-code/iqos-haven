"use client";
import {
  settingsResponseSchema,
  settingResponseSchema,
  type SettingsWriteRequest,
} from "@ih/contracts";
import { managementRequest, settingsCommand } from "../lib/management";
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
export function SettingsManagement() {
  const resource = useManagementResource("/settings", settingsResponseSchema);
  return (
    <>
      <ResourceNotice resource={resource} />
      {resource.data?.items.map((row) => {
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
          if (outcome.ok)
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
        }
        return (
          <section className="management-card" key={`${row.key}-${row.version}`}>
            <header className="card-heading">
              <h2>{group.title}</h2>
              <span className="badge">
                {row.value === null ? "Not configured" : "Configured"} · v{row.version}
              </span>
            </header>
            <p className="muted">{group.help}</p>
            <form
              data-unsaved={group.title.toLowerCase()}
              onSubmit={(e) => {
                e.preventDefault();
                void save(new FormData(e.currentTarget));
              }}
            >
              <fieldset disabled={resource.disabled}>
                <Fields fields={group.fields} value={value} />
                <div className="form-actions">
                  <button className="primary-button" type="submit">
                    Save {group.title.toLowerCase()}
                  </button>
                  {row.value !== null && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        if (window.confirm(`Clear ${group.title.toLowerCase()} configuration?`))
                          void save(null);
                      }}
                    >
                      Clear configuration
                    </button>
                  )}
                </div>
              </fieldset>
            </form>
          </section>
        );
      })}
    </>
  );
}
