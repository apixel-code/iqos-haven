import { spawnSync } from "node:child_process";
const checks = [
  "format:check",
  "build",
  "lint",
  "typecheck",
  "test",
  "test:boundaries",
  "test:infra",
  "test:package",
  "contracts:check",
];
if (process.argv.includes("--integration")) checks.push("test:int");
const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
for (const check of checks) {
  const result = spawnSync(command, [check], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0) {
    process.stderr.write("Verification stopped at " + check + "\n");
    process.exit(result.status ?? 1);
  }
}
if (!process.argv.includes("--integration"))
  process.stdout.write(
    "Foundation checks passed; real infrastructure integration was not requested.\n",
  );
