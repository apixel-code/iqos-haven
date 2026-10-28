import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { bootstrapEnvSchema, ConfigurationError, loadEnv, loadLocalEnvFile } from "@ih/config";
import { createDatabase, createPool, recoverOwnerAccess } from "@ih/db";
import { Argon2PasswordHasher, argon2ParamsFromEnv } from "@ih/platform";
import { runOwnerRecovery } from "./owner-recovery";
import { promptHidden, readFirstStdinLine } from "./terminal";

async function main(): Promise<number> {
  loadLocalEnvFile();
  const env = loadEnv(bootstrapEnvSchema);
  const pool = createPool({
    connectionString: env.DATABASE_URL,
    max: 2,
    applicationName: "ih-owner-recovery",
  });
  const db = createDatabase(pool);
  const hasher = new Argon2PasswordHasher(argon2ParamsFromEnv(env));
  try {
    return await runOwnerRecovery({
      argv: process.argv.slice(2),
      interactive: Boolean(process.stdin.isTTY),
      readPassword: (prompt, fromStdin) =>
        fromStdin ? readFirstStdinLine() : promptHidden(prompt),
      hash: (password) => hasher.hash(password),
      recover: (input) =>
        recoverOwnerAccess(
          db,
          { requestId: "owner-recovery-cli-" + randomUUID(), actorId: null },
          { ...input, reason: `${input.reason} [server user ${userInfo().username}]` },
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
        : "Recovery failed before changing anything.",
    );
    process.exit(1);
  },
);
