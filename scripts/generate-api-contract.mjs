import { format } from "prettier";
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { z } = require("zod");
const contracts = require("@ih/contracts");
const schemas = Object.fromEntries(
  ["LivenessResponse", "ReadinessResponse", "ErrorEnvelope"].map((name) => [
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
    title: "Iqos Haven — implemented internal foundation API",
    version: "0.0.0",
    description:
      "Only implemented health routes. Commerce endpoints are specifications in architecture.md, not live routes.",
  },
  paths: {
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
  process.stdout.write("Implemented health/error schemas generated.\n");
}
