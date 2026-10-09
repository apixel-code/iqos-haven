import { parseArgs } from "node:util";
import {
  normalizeEmail,
  normalizePassword,
  normalizeStaffName,
  passwordProblems,
} from "@ih/domain";

/**
 * First-Owner bootstrap (roadmap step 28). The Owner's email and name are operator input at run
 * time (business input BI-11), never repository data. The password is read from the terminal
 * without echo (or from stdin with --password-stdin for automation); it is never accepted as a
 * command-line argument or environment variable, and never printed or logged.
 */
export interface BootstrapDeps {
  readonly argv: readonly string[];
  readonly interactive: boolean;
  /** Reads one password: hidden terminal prompt, or the first stdin line when `fromStdin`. */
  readPassword(prompt: string, fromStdin: boolean): Promise<string>;
  /** Read-only pre-check so an operator is not asked for a password that cannot be used. */
  ownerExists(): Promise<boolean>;
  hash(password: string): Promise<string>;
  bootstrap(input: { email: string; name: string; passwordHash: string }): Promise<string>;
  out(line: string): void;
}

export const USAGE = `Usage: pnpm bootstrap:owner --email <address> --name "<full name>" [--password-stdin]

Creates the first Owner account. Refuses if any Owner already exists.
Without --password-stdin the password is prompted twice in the terminal (not echoed).`;

export type BootstrapExit = 0 | 1 | 2 | 3;

export async function runBootstrap(deps: BootstrapDeps): Promise<BootstrapExit> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...deps.argv],
      options: {
        email: { type: "string" },
        name: { type: "string" },
        "password-stdin": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    deps.out(USAGE);
    return 2;
  }
  if (values.help) {
    deps.out(USAGE);
    return 0;
  }
  let email: string;
  let name: string;
  try {
    email = normalizeEmail(values.email ?? "");
    name = normalizeStaffName(values.name ?? "");
  } catch (error) {
    deps.out(`Invalid input: ${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (await deps.ownerExists()) {
    deps.out("An Owner account already exists. Bootstrap refused; nothing was created.");
    return 3;
  }
  const fromStdin = values["password-stdin"];
  if (!fromStdin && !deps.interactive) {
    deps.out("No terminal available: pass the password on stdin with --password-stdin.");
    return 2;
  }
  let password: string;
  try {
    password = normalizePassword(await deps.readPassword("Owner password: ", fromStdin));
    if (!fromStdin) {
      const confirmation = normalizePassword(await deps.readPassword("Repeat password: ", false));
      if (confirmation !== password) {
        deps.out("Passwords do not match. Nothing was created.");
        return 2;
      }
    }
  } catch {
    deps.out("Password entry aborted. Nothing was created.");
    return 2;
  }
  const problems = passwordProblems(password, { email, name });
  if (problems.length) {
    deps.out(
      `Password rejected (${problems.join(", ")}). Use at least 12 characters, ` +
        "not containing the email, name, brand or common words. Nothing was created.",
    );
    return 2;
  }
  try {
    const id = await deps.bootstrap({ email, name, passwordHash: await deps.hash(password) });
    deps.out(`Owner created: ${email} (id ${id}).`);
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "OWNER_ALREADY_EXISTS") {
      deps.out("An Owner account already exists. Bootstrap refused; nothing was created.");
      return 3;
    }
    if (code === "STAFF_EMAIL_TAKEN") {
      deps.out("That email already belongs to a staff account. Nothing was created.");
      return 3;
    }
    deps.out(
      "Bootstrap failed; nothing was created. Check database connectivity and configuration.",
    );
    return 1;
  }
}
