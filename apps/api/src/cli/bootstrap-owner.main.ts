import { bootstrapEnvSchema, ConfigurationError, loadEnv, loadLocalEnvFile } from "@ih/config";
import { bootstrapFirstOwner, createDatabase, createPool, ownerExists } from "@ih/db";
import { Argon2PasswordHasher, argon2ParamsFromEnv } from "@ih/platform";
import { randomUUID } from "node:crypto";
import { runBootstrap } from "./bootstrap-owner";
import { promptHidden, readFirstStdinLine } from "./terminal";

async function main(): Promise<number> {
  loadLocalEnvFile();
  const env = loadEnv(bootstrapEnvSchema);
  const pool = createPool({
    connectionString: env.DATABASE_URL,
    max: 2,
    applicationName: "ih-bootstrap",
  });
  const db = createDatabase(pool);
  const hasher = new Argon2PasswordHasher(argon2ParamsFromEnv(env));
  try {
    return await runBootstrap({
      argv: process.argv.slice(2),
      interactive: Boolean(process.stdin.isTTY),
      readPassword: (prompt, fromStdin) =>
        fromStdin ? readFirstStdinLine() : promptHidden(prompt),
      ownerExists: () => ownerExists(db),
      hash: (password) => hasher.hash(password),
      bootstrap: (input) =>
        bootstrapFirstOwner(
          db,
          { requestId: "bootstrap-cli-" + randomUUID(), actorId: null },
          input,
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
        : "Bootstrap failed before creating anything.",
    );
    process.exit(1);
  },
);
