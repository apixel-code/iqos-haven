// Expand/deploy/contract guard (roadmap step 128, architecture §12 "CI/CD sequence"). A release
// runs its migrations BEFORE the new app starts, and a rollback runs the previous app on the new
// schema. So an ordinary migration may only expand: add tables, nullable columns, indexes,
// constraints the old code already satisfies. Anything that breaks the previous app (dropping or
// renaming tables/columns, changing a column type, making a column required, adding a required
// column without a default) is a contract
// migration: its folder ends in `_contract` and it names the release after which the old code
// no longer runs (`-- contract-after: <release>`), so it ships in a later release than the
// code that stopped using the old shape. Migrations up to the baseline were reviewed by hand.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FOLDER = "packages/db/prisma/migrations";
const BASELINE = "20261018000100_ops_alerts";
const CONTRACT = [
  [/\bDROP\s+TABLE\b/i, "DROP TABLE"],
  [/\bDROP\s+COLUMN\b/i, "DROP COLUMN"],
  [/\bRENAME\s+(COLUMN\s+)?[\w"]+\s+TO\b|\bRENAME\s+TO\b/i, "RENAME"],
  [/\bALTER\s+COLUMN\s+[\w"]+\s+(SET\s+DATA\s+)?TYPE\b/i, "ALTER COLUMN … TYPE"],
  [/\bSET\s+NOT\s+NULL\b/i, "SET NOT NULL"],
  [/\bDROP\s+(VIEW|FUNCTION|TYPE|SCHEMA)\b/i, "DROP VIEW/FUNCTION/TYPE/SCHEMA"],
];

/** Problems with one migration (empty when it is a valid expand or a declared contract). */
export function migrationProblems(name, sql) {
  const code = sql.replace(/--.*$/gm, "");
  const found = CONTRACT.filter(([pattern]) => pattern.test(code)).map(([, label]) => label);
  // A required column without a default: the previous app's INSERTs do not supply it.
  const required = [...code.matchAll(/\bADD\s+COLUMN\b([^,;]*)/gi)].some(
    ([, definition]) => /\bNOT\s+NULL\b/i.test(definition) && !/\bDEFAULT\b/i.test(definition),
  );
  if (required) found.push("ADD COLUMN … NOT NULL without DEFAULT");
  const declared = name.endsWith("_contract");
  const after = /^--\s*contract-after:\s*\S+/m.test(sql);
  if (declared && !after)
    return [`${name}: contract migration without "-- contract-after: <release>"`];
  if (declared && !found.length)
    return [`${name}: named _contract but contains no contract change`];
  if (!declared && found.length)
    return [
      `${name}: ${found.join(", ")} breaks the previous release; move it to a later *_contract migration`,
    ];
  return [];
}

// The rule itself, checked on every run so a regex change cannot silently weaken it.
assert.deepEqual(
  migrationProblems("20990101000000_add_note", "ALTER TABLE orders ADD COLUMN note text;"),
  [],
);
assert.equal(
  migrationProblems("20990101000000_drop_note", "ALTER TABLE orders DROP COLUMN note;").length,
  1,
);
assert.equal(
  migrationProblems("20990101000000_req", 'ALTER TABLE "orders" ALTER COLUMN "note" SET NOT NULL;')
    .length,
  1,
);
assert.equal(
  migrationProblems("20990101000000_ren", "ALTER TABLE orders RENAME COLUMN note TO memo;").length,
  1,
);
assert.equal(
  migrationProblems("20990101000000_typ", "ALTER TABLE orders ALTER COLUMN note TYPE varchar(10);")
    .length,
  1,
);
assert.equal(
  migrationProblems("20990101000000_req2", "ALTER TABLE orders ADD COLUMN note text NOT NULL;")
    .length,
  1,
);
assert.deepEqual(
  migrationProblems(
    "20990101000000_def",
    "ALTER TABLE orders ADD COLUMN note text NOT NULL DEFAULT '';",
  ),
  [],
);
assert.deepEqual(
  migrationProblems("20990101000000_cmt", "-- we never DROP COLUMN here\nSELECT 1;"),
  [],
);
assert.equal(
  migrationProblems("20990101000000_drop_note_contract", "ALTER TABLE orders DROP COLUMN note;")
    .length,
  1,
);
assert.deepEqual(
  migrationProblems(
    "20990101000000_drop_note_contract",
    "-- contract-after: 1a2b3c4\nALTER TABLE orders DROP COLUMN note;",
  ),
  [],
);

const names = readdirSync(FOLDER, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert.ok(names.includes(BASELINE), `baseline ${BASELINE} not found`);
const checked = names.filter((name) => name > BASELINE);
const problems = checked.flatMap((name) =>
  migrationProblems(name, readFileSync(join(FOLDER, name, "migration.sql"), "utf8")),
);
if (problems.length) {
  for (const problem of problems) process.stderr.write(problem + "\n");
  process.exit(1);
}
process.stdout.write(
  `Migration guard: ${checked.length} migration(s) after the baseline are expand-only or declared contracts (rule self-test passed).\n`,
);
