import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { ConfigurationError, launchCheckEnvSchema, loadEnv, loadLocalEnvFile } from "@ih/config";
import { createDatabase, createPool, listDeadEffects, replayDeadEffect } from "@ih/db";
import { runEffects } from "./effects";

async function main(): Promise<number> {
  loadLocalEnvFile();
  const env = loadEnv(launchCheckEnvSchema);
  const pool = createPool({
    connectionString: env.DATABASE_URL,
    max: 1,
    applicationName: "ih-ops-effects",
  });
  const db = createDatabase(pool);
  try {
    return await runEffects({
      argv: process.argv.slice(2),
      list: (options) => listDeadEffects(db, options),
      replay: (effectId, reason) =>
        replayDeadEffect(
          db,
          { requestId: "ops-effects-cli-" + randomUUID(), actorId: null },
          effectId,
          `${reason} [server user ${userInfo().username}]`,
        ),
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
      error instanceof ConfigurationError
        ? error.message
        : "ops:effects failed; nothing was changed. Check database connectivity and configuration.",
    );
    process.exit(1);
  },
);
