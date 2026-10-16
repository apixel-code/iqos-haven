import {
  analyticsBackfillEnvSchema,
  ConfigurationError,
  loadEnv,
  loadLocalEnvFile,
} from "@ih/config";
import { backfillRollups, createDatabase, createPool } from "@ih/db";
import { runBackfill } from "./rollup-backfill";

async function main(): Promise<number> {
  loadLocalEnvFile();
  const env = loadEnv(analyticsBackfillEnvSchema);
  const pool = createPool({
    connectionString: env.DATABASE_URL,
    max: 2,
    applicationName: "ih-analytics-backfill",
  });
  const db = createDatabase(pool);
  const stop = new AbortController();
  // Ctrl-C finishes the current day and stops: every finished day is already complete.
  process.once("SIGINT", () => stop.abort());
  try {
    return await runBackfill({
      argv: process.argv.slice(2),
      now: new Date(),
      backfill: (from, to, parts, onDay) =>
        backfillRollups(db, from, to, { parts, onDay, signal: stop.signal }),
      out: (line) => process.stdout.write(line + "\n"),
    });
  } finally {
    await db.$disconnect();
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      error instanceof ConfigurationError ? error.message : "Backfill failed before starting.",
    );
    process.exit(1);
  },
);
