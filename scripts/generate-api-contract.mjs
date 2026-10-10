import { format } from "prettier";
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
  ].map((name) => [
    name,
    z.toJSONSchema(contracts[name[0].toLowerCase() + name.slice(1) + "Schema"], {
      target: "openapi-3.0",
    }),
  ]),
);
schemas.StaffEditRequest.anyOf = [{ required: ["name"] }, { required: ["email"] }];
const content = (name) => ({
  "application/json": { schema: { $ref: "#/components/schemas/" + name } },
});
const document = {
  openapi: "3.0.3",
  info: {
    title: "Iqos Haven — implemented API contracts",
    version: "0.0.0",
    description:
      "Implemented health, identity and staff administration contracts. Browser identity commands require the configured admin Origin and JSON bodies; responses are no-store. Identity UI is roadmap step 37.",
  },
  paths: {
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
const output = await format(JSON.stringify(document), { parser: "json" });
const file = "docs/api.openapi.json";
if (process.argv.includes("--check")) {
  if (!existsSync(file) || readFileSync(file, "utf8") !== output) {
    process.stderr.write("Contract drift: run pnpm contracts:generate after building contracts.\n");
    process.exitCode = 1;
  }
} else {
  writeFileSync(file, output);
  process.stdout.write("Implemented health/identity/error schemas generated.\n");
}
