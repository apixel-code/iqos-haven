import { format, resolveConfig } from "prettier";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { z } = require("zod");
const contracts = require("@ih/contracts");
const schemas = Object.fromEntries(
  [
    "LivenessResponse",
    "ReadinessResponse",
    "ErrorEnvelope",
    "ForgotRequest",
    "ForgotResponse",
    "ResetRequest",
    "InvitationRequest",
    "InvitationResponse",
    "InvitationRevokeRequest",
    "InvitationAcceptRequest",
    "StaffResponse",
    "StaffListResponse",
    "StaffEditRequest",
    "StaffDeactivateRequest",
    "StaffRoleRequest",
    "StaffReactivateRequest",
    "DeliveryConfigurationWriteRequest",
    "DeliveryConfigurationResponse",
    "DeliveryAreaCreateRequest",
    "DeliveryAreaUpdateRequest",
    "DeliveryAreaResponse",
    "DeliveryAreasResponse",
    "SettingsWriteRequest",
    "SettingResponse",
    "SettingsResponse",
  ].map((name) => [
    name,
    z.toJSONSchema(contracts[name[0].toLowerCase() + name.slice(1) + "Schema"], {
      target: "openapi-3.0",
    }),
  ]),
);
schemas.StaffEditRequest.anyOf = [{ required: ["name"] }, { required: ["email"] }];
// Zod refinements are enforced at runtime; describe the cross-field recipient rule explicitly.
function annotateNotifications(schema) {
  if (!schema || typeof schema !== "object") return;
  if (schema.properties?.enabled && schema.properties?.recipients) {
    schema.anyOf = [
      { properties: { enabled: { enum: [false] } } },
      { properties: { recipients: { minItems: 1 } } },
    ];
    schema.properties.recipients.description =
      "Unique case-insensitively; no real defaults or delivery activation supplied.";
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) value.forEach(annotateNotifications);
    else if (value && typeof value === "object") annotateNotifications(value);
  }
}
for (const name of ["SettingsWriteRequest", "SettingResponse", "SettingsResponse"])
  annotateNotifications(schemas[name]);
const content = (name) => ({
  "application/json": { schema: { $ref: "#/components/schemas/" + name } },
});
const deliveryErrors = {
  400: { description: "Strict input validation failed", content: content("ErrorEnvelope") },
  401: { description: "Session required", content: content("ErrorEnvelope") },
  403: {
    description: "delivery.manage or admin Origin required",
    content: content("ErrorEnvelope"),
  },
};
const deliveryMutationErrors = {
  ...deliveryErrors,
  409: {
    description: "Duplicate code/name or stale version; reload current data",
    content: content("ErrorEnvelope"),
  },
  429: { description: "Rate limited", content: content("ErrorEnvelope") },
  503: { description: "Authoritative limiter unavailable", content: content("ErrorEnvelope") },
};
const document = {
  openapi: "3.0.3",
  info: {
    title: "Iqos Haven — implemented API contracts",
    version: "0.0.0",
    description:
      "Implemented health, identity, staff, settings and delivery administration contracts. Browser identity commands require the configured admin Origin and JSON bodies; responses are no-store. Identity UI is roadmap step 37.",
  },
  paths: {
    "/v1/admin/delivery-areas": {
      get: {
        operationId: "deliveryAreasList",
        security: [{ adminSession: [] }],
        description:
          "Requires delivery.manage. No-store list of active and inactive Dubai areas; no public selection endpoint. No prototype areas seeded.",
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
          },
          { name: "after", in: "query", schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          200: {
            description: "Bounded areas ordered by immutable ID",
            content: content("DeliveryAreasResponse"),
          },
          ...deliveryErrors,
        },
      },
      post: {
        operationId: "deliveryAreaCreate",
        security: [{ adminSession: [] }],
        description:
          "Owner configuration with delivery.manage; admin Origin/JSON. Create a client-approved Dubai area. Stable unique code and case-insensitive unique name; no zone fee/delete. Atomic audit and IDs-only event.",
        requestBody: { required: true, content: content("DeliveryAreaCreateRequest") },
        responses: {
          201: {
            description: "Created area at version 1",
            content: content("DeliveryAreaResponse"),
          },
          ...deliveryMutationErrors,
        },
      },
    },
    "/v1/admin/delivery-areas/{id}": {
      patch: {
        operationId: "deliveryAreaUpdate",
        security: [{ adminSession: [] }],
        description:
          "Requires delivery.manage and expected version. Replace name/active state; code/emirate/ID immutable. Deactivate rather than delete. No-op preserves metadata; atomic audit/outbox.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: { required: true, content: content("DeliveryAreaUpdateRequest") },
        responses: {
          200: { description: "Current versioned area", content: content("DeliveryAreaResponse") },
          404: { description: "Area not found", content: content("ErrorEnvelope") },
          ...deliveryMutationErrors,
        },
      },
    },
    "/v1/admin/delivery-areas/configuration": {
      get: {
        operationId: "deliveryConfigurationRead",
        security: [{ adminSession: [] }],
        description:
          "Requires delivery.manage. One flat Dubai fee/ETA; absent configuration is null/version 0. No defaults; no-store. Unknown query fields rejected.",
        responses: {
          200: {
            description: "Current configuration",
            content: content("DeliveryConfigurationResponse"),
          },
          ...deliveryErrors,
        },
      },
      patch: {
        operationId: "deliveryConfigurationWrite",
        security: [{ adminSession: [] }],
        description:
          "Requires delivery.manage, admin Origin/JSON and expected version. 0 creates, null clears without deleting history. Integer fils; free threshold remains null (disabled). Atomic metadata-only audit/IDs-only event. Changes require quote re-acceptance in later pricing steps.",
        requestBody: { required: true, content: content("DeliveryConfigurationWriteRequest") },
        responses: {
          200: {
            description: "Current versioned configuration",
            content: content("DeliveryConfigurationResponse"),
          },
          ...deliveryMutationErrors,
        },
      },
    },
    "/v1/admin/settings": {
      get: {
        operationId: "settingsRead",
        security: [{ adminSession: [] }],
        description:
          "Requires settings.manage. Four typed groups; absent values are null/version 0. No prototype defaults. Private/no-store; no public settings endpoint.",
        responses: {
          200: { description: "Typed current configuration", content: content("SettingsResponse") },
          400: { description: "Unknown query", content: content("ErrorEnvelope") },
          401: { description: "Session required", content: content("ErrorEnvelope") },
          403: { description: "Permission denied", content: content("ErrorEnvelope") },
        },
      },
      patch: {
        operationId: "settingsWrite",
        security: [{ adminSession: [] }],
        description:
          "Requires settings.manage and expected version. Replace one typed value; 0 creates an absent key, null clears without deleting history. Settings alone do not activate email/WhatsApp delivery. Unknown keys/fields rejected; audit and IDs-only event atomic.",
        requestBody: { required: true, content: content("SettingsWriteRequest") },
        responses: {
          200: {
            description: "Current versioned configuration group",
            content: content("SettingResponse"),
          },
          400: { description: "Invalid typed configuration", content: content("ErrorEnvelope") },
          401: { description: "Session required", content: content("ErrorEnvelope") },
          403: { description: "Permission or Origin denied", content: content("ErrorEnvelope") },
          409: {
            description: "Stale version; reload current settings",
            content: content("ErrorEnvelope"),
          },
          429: { description: "Rate limited", content: content("ErrorEnvelope") },
          503: {
            description: "Authoritative limiter unavailable",
            content: content("ErrorEnvelope"),
          },
        },
      },
    },
    "/v1/admin/staff": {
      get: {
        operationId: "staffList",
        security: [{ adminSession: [] }],
        description: "Requires staff.manage; sanitized keyset pagination by immutable user ID.",
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", minimum: 1, maximum: 100, default: 25 },
          },
          { name: "after", in: "query", schema: { type: "string", format: "uuid" } },
        ],
        responses: {
          200: { description: "Bounded staff page", content: content("StaffListResponse") },
          400: { description: "Invalid query", content: content("ErrorEnvelope") },
          401: { description: "Session required", content: content("ErrorEnvelope") },
          403: { description: "Permission denied", content: content("ErrorEnvelope") },
        },
      },
    },
    "/v1/admin/staff/{id}": {
      patch: {
        operationId: "staffEdit",
        security: [{ adminSession: [] }],
        description:
          "Requires staff.manage and current version; edit name/email only. Email changes revoke all sessions and durable identity capabilities.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: { required: true, content: content("StaffEditRequest") },
        responses: {
          200: { description: "Updated sanitized staff member", content: content("StaffResponse") },
          400: { description: "Invalid edit", content: content("ErrorEnvelope") },
          401: { description: "Session required", content: content("ErrorEnvelope") },
          403: { description: "Permission or Origin denied", content: content("ErrorEnvelope") },
          404: { description: "Staff member absent", content: content("ErrorEnvelope") },
          409: {
            description: "Stale version or email conflict",
            content: content("ErrorEnvelope"),
          },
          429: { description: "Rate limited", content: content("ErrorEnvelope") },
          503: {
            description: "Authoritative limiter unavailable",
            content: content("ErrorEnvelope"),
          },
        },
      },
    },
    "/v1/admin/staff/{id}/deactivate": {
      post: {
        operationId: "staffDeactivate",
        security: [{ adminSession: [] }],
        description:
          "Requires staff.manage and current version; never deletes users; common Owner lock prevents last active Owner removal. Sessions/reset/issued invitations revoked atomically.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: { required: true, content: content("StaffDeactivateRequest") },
        responses: {
          204: { description: "Deactivated, or already inactive at the supplied current version" },
          400: { description: "Invalid request", content: content("ErrorEnvelope") },
          401: { description: "Session required", content: content("ErrorEnvelope") },
          403: { description: "Permission or Origin denied", content: content("ErrorEnvelope") },
          404: { description: "Staff member absent", content: content("ErrorEnvelope") },
          409: {
            description: "Stale version or last active Owner",
            content: content("ErrorEnvelope"),
          },
          429: { description: "Rate limited", content: content("ErrorEnvelope") },
          503: {
            description: "Authoritative limiter unavailable",
            content: content("ErrorEnvelope"),
          },
        },
      },
    },
    "/v1/admin/staff/{id}/role": {
      post: {
        operationId: "staffRole",
        security: [{ adminSession: [] }],
        description:
          "Requires staff.manage and current version. Change a fixed Owner/Staff role; last-active-Owner protected. All sessions and durable capabilities revoked.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: { required: true, content: content("StaffRoleRequest") },
        responses: {
          200: { description: "Current sanitized staff member", content: content("StaffResponse") },
          400: { description: "Invalid request", content: content("ErrorEnvelope") },
          401: { description: "Session required", content: content("ErrorEnvelope") },
          403: { description: "Permission or Origin denied", content: content("ErrorEnvelope") },
          404: { description: "Staff member absent", content: content("ErrorEnvelope") },
          409: {
            description: "Stale version or last active Owner",
            content: content("ErrorEnvelope"),
          },
          429: { description: "Rate limited", content: content("ErrorEnvelope") },
          503: {
            description: "Authoritative limiter unavailable",
            content: content("ErrorEnvelope"),
          },
        },
      },
    },
    "/v1/admin/staff/{id}/reactivate": {
      post: {
        operationId: "staffReactivate",
        security: [{ adminSession: [] }],
        description:
          "Requires staff.manage and current version. Reactivate an existing account with its saved role/password. Previously revoked capabilities stay revoked; no auto-login.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
        ],
        requestBody: { required: true, content: content("StaffReactivateRequest") },
        responses: {
          200: { description: "Current sanitized staff member", content: content("StaffResponse") },
          400: { description: "Invalid request", content: content("ErrorEnvelope") },
          401: { description: "Session required", content: content("ErrorEnvelope") },
          403: { description: "Permission or Origin denied", content: content("ErrorEnvelope") },
          404: { description: "Staff member absent", content: content("ErrorEnvelope") },
          409: {
            description: "Stale version or last active Owner",
            content: content("ErrorEnvelope"),
          },
          429: { description: "Rate limited", content: content("ErrorEnvelope") },
          503: {
            description: "Authoritative limiter unavailable",
            content: content("ErrorEnvelope"),
          },
        },
      },
    },
    "/v1/admin/staff/invitations": {
      post: {
        operationId: "staffInvite",
        security: [{ adminSession: [] }],
        description:
          "Requires staff.manage; approved recipient/name/role stored by the server. Resend revokes the prior pending invitation.",
        requestBody: { required: true, content: content("InvitationRequest") },
        responses: {
          201: {
            description: "Invitation issued; secret delivered only by worker email",
            content: content("InvitationResponse"),
          },
          400: { description: "Invalid request", content: content("ErrorEnvelope") },
          401: { description: "Session required", content: content("ErrorEnvelope") },
          403: { description: "Permission or Origin denied", content: content("ErrorEnvelope") },
          409: { description: "Account already exists", content: content("ErrorEnvelope") },
          429: { description: "Rate limited", content: content("ErrorEnvelope") },
          503: {
            description: "Invitation configuration or limiter unavailable",
            content: content("ErrorEnvelope"),
          },
        },
      },
    },
    "/v1/admin/staff/invitations/revoke": {
      post: {
        operationId: "staffInviteRevoke",
        security: [{ adminSession: [] }],
        description:
          "Requires staff.manage; idempotent for nonexistent/accepted/revoked invitations.",
        requestBody: { required: true, content: content("InvitationRevokeRequest") },
        responses: {
          204: { description: "Pending invitation revoked" },
          400: { description: "Invalid request", content: content("ErrorEnvelope") },
          401: { description: "Session required", content: content("ErrorEnvelope") },
          403: { description: "Permission or Origin denied", content: content("ErrorEnvelope") },
          429: { description: "Rate limited", content: content("ErrorEnvelope") },
          503: { description: "Limiter unavailable", content: content("ErrorEnvelope") },
        },
      },
    },
    "/v1/auth/invite/accept": {
      post: {
        operationId: "staffInviteAccept",
        description:
          "Single-use 24-hour invitation. Recipient, name and role cannot be supplied by the invitee. Existing accounts are never overwritten/reactivated.",
        requestBody: { required: true, content: content("InvitationAcceptRequest") },
        responses: {
          204: { description: "Account created with the stored role; no auto-login" },
          400: { description: "Invalid invitation or password", content: content("ErrorEnvelope") },
          403: { description: "Origin denied", content: content("ErrorEnvelope") },
          429: { description: "Rate limited; Retry-After set", content: content("ErrorEnvelope") },
          503: {
            description: "Invitation configuration or limiter unavailable",
            content: content("ErrorEnvelope"),
          },
        },
      },
    },
    "/v1/auth/forgot": {
      post: {
        operationId: "passwordResetRequest",
        requestBody: { required: true, content: content("ForgotRequest") },
        responses: {
          200: {
            description: "Accepted, irrespective of account existence",
            content: content("ForgotResponse"),
          },
          400: { description: "Invalid request", content: content("ErrorEnvelope") },
          403: { description: "Origin denied", content: content("ErrorEnvelope") },
          415: { description: "JSON required", content: content("ErrorEnvelope") },
          429: { description: "Rate limited; Retry-After set", content: content("ErrorEnvelope") },
          503: {
            description: "Reset configuration or authoritative limiter unavailable",
            content: content("ErrorEnvelope"),
          },
        },
      },
    },
    "/v1/auth/reset": {
      post: {
        operationId: "passwordResetConsume",
        requestBody: { required: true, content: content("ResetRequest") },
        responses: {
          204: {
            description: "Password changed; all sessions and sibling links revoked; no auto-login",
          },
          400: {
            description: "Invalid request, link or password",
            content: content("ErrorEnvelope"),
          },
          403: { description: "Origin denied", content: content("ErrorEnvelope") },
          415: { description: "JSON required", content: content("ErrorEnvelope") },
          429: { description: "Rate limited; Retry-After set", content: content("ErrorEnvelope") },
          503: {
            description: "Reset configuration or authoritative limiter unavailable",
            content: content("ErrorEnvelope"),
          },
        },
      },
    },
    "/v1/health/live": {
      get: {
        operationId: "healthLive",
        responses: { 200: { description: "Process alive", content: content("LivenessResponse") } },
      },
    },
    "/v1/health/ready": {
      get: {
        operationId: "healthReady",
        responses: {
          200: { description: "Ready or queue degraded", content: content("ReadinessResponse") },
          503: { description: "Database unavailable", content: content("ReadinessResponse") },
        },
      },
    },
  },
  components: {
    schemas,
    securitySchemes: { adminSession: { type: "apiKey", in: "cookie", name: "__Host-ih_admin" } },
  },
};
const file = "docs/api.openapi.json";
const output = await format(JSON.stringify(document), {
  ...(await resolveConfig(file)),
  parser: "json",
});
if (process.argv.includes("--check")) {
  if (!existsSync(file) || readFileSync(file, "utf8") !== output) {
    process.stderr.write("Contract drift: run pnpm contracts:generate after building contracts.\n");
    process.exitCode = 1;
  }
} else {
  writeFileSync(file, output);
  process.stdout.write("Implemented health/identity/settings/error schemas generated.\n");
}
