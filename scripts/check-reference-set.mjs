import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
for (const name of [
  "architecture",
  "roadmap",
  "requirements",
  "acceptance",
  "design-handoff",
  "environment",
  "implementation-status",
  "business-inputs",
])
  assert(existsSync("docs/" + name + ".md"), "Missing reference: " + name);
const architecture = readFileSync("docs/architecture.md", "utf8");
assert(
  architecture.includes("PostgreSQL 18") &&
    architecture.includes("Prisma") &&
    architecture.includes("Fastify"),
);
const steps = [...readFileSync("docs/roadmap.md", "utf8").matchAll(/^\|\s*(\d+)\s*\|/gm)].map(
  (match) => Number(match[1]),
);
assert.deepEqual(
  steps,
  Array.from({ length: 132 }, (_, index) => index + 1),
);
const store = readFileSync("docs/prototypes/storefront.html", "utf8");
assert(!/store\.(set|get)\("co"/.test(store), "Prototype checkout persistence returned");
assert(
  !/store\.(set|get)\("lastOrder"/.test(store),
  "Prototype confirmation PII persistence returned",
);
process.stdout.write("Reference set, 132 steps and prototype privacy checks passed.\n");
