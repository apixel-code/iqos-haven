import { launchCheckEnvSchema, ConfigurationError, loadEnv, loadLocalEnvFile } from "@ih/config";
import { createDatabase, createPool, launchFacts, shippedMigrations } from "@ih/db";
import { evaluateLaunch, formatLaunch } from "./launch-check";

/** `pnpm launch:check` (step 124): read-only launch readiness of the database in DATABASE_URL. */
async function main(): Promise<number> {
  loadLocalEnvFile();
  const env = loadEnv(launchCheckEnvSchema);
  const pool = createPool({
    connectionString: env.DATABASE_URL,
    max: 1,
    applicationName: "ih-launch-check",
  });
  const db = createDatabase(pool);
  try {
    const { text, exitCode } = formatLaunch(
      evaluateLaunch(await launchFacts(db), shippedMigrations()),
    );
    process.stdout.write(text + "\n");
    return exitCode;
  } finally {
    await db.$disconnect();
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      error instanceof ConfigurationError
        ? error.message
        : "Launch check could not read the database.",
    );
    process.exit(2);
  },
);
