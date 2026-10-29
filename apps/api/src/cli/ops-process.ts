import { spawn } from "node:child_process";
import { resolve } from "node:path";

/** The repository root (where docker-compose.yml lives), from `apps/api/dist/cli`. */
export const repoRoot = resolve(__dirname, "../../../..");

/**
 * Runs a command and returns its stdout. Used for `docker compose exec` into the Postgres
 * service (step 126): pg_dump and pg_restore run where the server and its version are.
 * Errors carry only the last lines of stderr, never the input.
 */
export function run(
  command: string,
  args: readonly string[],
  input?: Buffer,
  env?: NodeJS.ProcessEnv,
): Promise<Buffer> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", fail);
    child.on("close", (code) => {
      if (code === 0) done(Buffer.concat(out));
      else
        fail(
          new Error(
            `${command} ${args.slice(0, 4).join(" ")} exited ${code}: ` +
              Buffer.concat(err).toString("utf8").trim().split("\n").slice(-3).join(" | "),
          ),
        );
    });
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}

/** `docker compose exec -T <service> …` from the repository root. */
export const composeExec = (service: string, args: readonly string[], input?: Buffer) =>
  run("docker", ["compose", "exec", "-T", service, ...args], input);

/**
 * libpq connection variables for DATABASE_MIGRATION_URL. The password travels in the child's
 * environment, never on its command line (where `ps` would show it).
 */
export function libpqEnv(url: string): NodeJS.ProcessEnv {
  const parsed = new URL(url);
  return {
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || "5432",
    PGPASSWORD: decodeURIComponent(parsed.password),
  };
}

/**
 * Runs a PostgreSQL client tool (pg_dump, pg_restore, psql). `compose` (local development)
 * runs it inside the Compose Postgres service; `local` (the ops image on a server, step 122b)
 * runs the image's own PostgreSQL 18 client against the migration URL's host.
 */
export const pgTool = (
  env: {
    BACKUP_PG_TOOLS: "compose" | "local";
    BACKUP_POSTGRES_SERVICE: string;
    DATABASE_MIGRATION_URL: string;
  },
  args: readonly [string, ...string[]],
  input?: Buffer,
) =>
  env.BACKUP_PG_TOOLS === "local"
    ? run(args[0], args.slice(1), input, libpqEnv(env.DATABASE_MIGRATION_URL))
    : composeExec(env.BACKUP_POSTGRES_SERVICE, args, input);
