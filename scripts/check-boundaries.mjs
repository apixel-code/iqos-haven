import assert from "node:assert/strict";
import { ESLint } from "eslint";
const root = new ESLint();
const probes = [
  ["packages/domain/src/money.ts", "@ih/db", false],
  ["packages/domain/src/money.ts", "../../db/src/client", false],
  ["packages/contracts/src/index.ts", "@nestjs/common", false],
  ["packages/application/src/index.ts", "@ih/db", false],
  ["packages/application/src/index.ts", "next/server", false],
  ["packages/application/src/index.ts", "@ih/domain", true],
  ["packages/db/src/client.ts", "@ih/api", false],
  ["packages/db/src/outbox.ts", "@ih/db/testing", false],
  ["apps/worker/src/main.ts", "@ih/db/testing", false],
  ["apps/worker/src/relay.int.test.ts", "@ih/db/testing", true],
];
for (const [filePath, dependency, allowed] of probes) {
  const [result] = await root.lintText(
    'import * as imported from "' + dependency + '";\nexport { imported };\n',
    { filePath },
  );
  const blocked = result.messages.some((item) => item.ruleId === "no-restricted-imports");
  assert.equal(blocked, !allowed, filePath + ": " + dependency);
}
for (const app of ["storefront", "admin"]) {
  const eslint = new ESLint({ cwd: process.cwd() + "/apps/" + app });
  const [result] = await eslint.lintText(
    'import * as imported from "@ih/db";\nexport { imported };\n',
    { filePath: "app/page.tsx" },
  );
  assert(result.messages.some((item) => item.ruleId === "no-restricted-imports"));
}
process.stdout.write("12 package-boundary probes passed.\n");
