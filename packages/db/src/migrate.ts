import { spawn } from "node:child_process";
import { join } from "node:path";
import { loadEnv, loadLocalEnvFile, migrationEnvSchema } from "@ih/config";
import { assertMigrationBundle } from "./migration-policy";
async function main(): Promise<void> {
  loadLocalEnvFile();
  const env = loadEnv(migrationEnvSchema);
  const packageRoot = join(__dirname, "..");
  const count = assertMigrationBundle(
    join(packageRoot, "prisma", "migrations"),
    env.APP_ENV,
    process.argv.includes("--allow-empty"),
  );
  if (!count) {
    process.stdout.write("Local scaffold only: no business migrations exist.\n");
    return;
  }
  const entry = require.resolve("prisma");
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [entry, "migrate", "deploy", "--config", join(packageRoot, "prisma.config.ts")],
      {
        cwd: packageRoot,
        env: { ...process.env, DATABASE_MIGRATION_URL: env.DATABASE_MIGRATION_URL },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  process.exitCode = code;
}
main().catch(() => {
  console.error("Migration failed; verify the bundle, migration credentials and database state.");
  process.exitCode = 1;
});
