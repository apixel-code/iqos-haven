import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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
// Prototype traps (step 100): demo coupon codes and fixed free-delivery claims never reach
// application code. Tests may name a code to prove it is refused.
const DEMO =
  /\b(HAVEN10|SAVE20|VEKTOR15|BIGBOX15)\b|free (delivery )?on orders (of|over)|free delivery over/i;
const skip = /(^|\/)(node_modules|\.next|dist|generated|coverage|\.turbo)(\/|$)|\.test\.tsx?$/;
function* sources(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (skip.test(path)) continue;
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.(tsx?|css|mjs|cjs)$/.test(name)) yield path;
  }
}
// The launch check (step 124, ADR 0095) names the demo codes only to find and block them.
const DETECTORS = new Set(["packages/db/src/launch-readiness.ts"]);
for (const root of ["apps", "packages"])
  for (const file of sources(root))
    assert(
      DETECTORS.has(file) || !DEMO.test(readFileSync(file, "utf8")),
      "Prototype demo coupon or free-delivery claim in " + file,
    );
process.stdout.write("Reference set, 132 steps, prototype privacy and demo-copy checks passed.\n");
