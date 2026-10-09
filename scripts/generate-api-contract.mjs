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
  ].map((name) => [
    name,
    z.toJSONSchema(contracts[name[0].toLowerCase() + name.slice(1) + "Schema"], {
      target: "openapi-3.0",
    }),
  ]),
);
const content = (name) => ({
  "application/json": { schema: { $ref: "#/components/schemas/" + name } },
});
const document = {
  openapi: "3.0.3",
  info: {
    title: "Iqos Haven — implemented API contracts",
    version: "0.0.0",
    description:
      "Implemented health and password-reset contracts. Browser reset commands require the configured admin Origin and JSON bodies; responses are no-store. Reset UI is roadmap step 37.",
  },
  paths: {
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
  components: { schemas },
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
  process.stdout.write("Implemented health/password-reset/error schemas generated.\n");
}
