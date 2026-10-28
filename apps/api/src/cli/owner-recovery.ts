import { parseArgs } from "node:util";
import { normalizeEmail, normalizePassword, passwordProblems } from "@ih/domain";

/**
 * Break-glass Owner recovery (roadmap step 127, ADR 0099). For the case the admin cannot solve:
 * no Owner can sign in or receive a reset email. Server shell access plus the database
 * credentials are the authorization; the incident reason is required and audited. The password
 * is read like bootstrap's (hidden prompt or --password-stdin), never from an argument or env.
 */
export interface RecoveryDeps {
  readonly argv: readonly string[];
  readonly interactive: boolean;
  readPassword(prompt: string, fromStdin: boolean): Promise<string>;
  hash(password: string): Promise<string>;
  recover(input: {
    email: string;
    passwordHash: string;
    reason: string;
    despiteActiveOwner: boolean;
  }): Promise<{
    id: string;
    reactivated: boolean;
    sessionsRevoked: number;
    otherActiveOwners: number;
  }>;
  out(line: string): void;
}

export const RECOVERY_USAGE = `Usage: pnpm ops:owner-recovery --email <owner address> --reason "<incident id: what happened>"
                              [--despite-active-owner] [--password-stdin]

Restores sign-in to an existing Owner account when no Owner can sign in or receive a reset
email: sets a new password, reactivates the account and signs it out everywhere (sessions,
reset links and its pending invitations are revoked). The role never changes and no account is
created. Refused while another Owner is active, unless --despite-active-owner says that Owner
is not trusted. Use the admin (password reset, Staff & roles) whenever an Owner can sign in.`;

export type RecoveryExit = 0 | 1 | 2 | 3;

export async function runOwnerRecovery(deps: RecoveryDeps): Promise<RecoveryExit> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...deps.argv],
      options: {
        email: { type: "string" },
        reason: { type: "string" },
        "despite-active-owner": { type: "boolean", default: false },
        "password-stdin": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    deps.out(RECOVERY_USAGE);
    return 2;
  }
  if (values.help) {
    deps.out(RECOVERY_USAGE);
    return 0;
  }
  let email: string;
  try {
    email = normalizeEmail(values.email ?? "");
  } catch (error) {
    deps.out(`Invalid input: ${(error as Error).message}\n\n${RECOVERY_USAGE}`);
    return 2;
  }
  const reason = (values.reason ?? "").trim();
  if (reason.length < 8 || reason.length > 500) {
    deps.out(`A reason with the incident ID is required (8–500 characters).\n\n${RECOVERY_USAGE}`);
    return 2;
  }
  const fromStdin = values["password-stdin"];
  if (!fromStdin && !deps.interactive) {
    deps.out("No terminal available: pass the password on stdin with --password-stdin.");
    return 2;
  }
  let password: string;
  try {
    password = normalizePassword(await deps.readPassword("New Owner password: ", fromStdin));
    if (!fromStdin) {
      const confirmation = normalizePassword(await deps.readPassword("Repeat password: ", false));
      if (confirmation !== password) {
        deps.out("Passwords do not match. Nothing was changed.");
        return 2;
      }
    }
  } catch {
    deps.out("Password entry aborted. Nothing was changed.");
    return 2;
  }
  const problems = passwordProblems(password, { email });
  if (problems.length) {
    deps.out(
      `Password rejected (${problems.join(", ")}). Use at least 12 characters, ` +
        "not containing the email, name, brand or common words. Nothing was changed.",
    );
    return 2;
  }
  try {
    const result = await deps.recover({
      email,
      passwordHash: await deps.hash(password),
      reason,
      despiteActiveOwner: values["despite-active-owner"],
    });
    deps.out(
      [
        `Owner access restored: ${email} (id ${result.id}).`,
        `${result.reactivated ? "Reactivated; " : ""}${result.sessionsRevoked} session(s) signed out; reset links and pending invitations from this account revoked.`,
        result.otherActiveOwners
          ? `${result.otherActiveOwners} other active Owner(s): review them in Staff & roles and deactivate any that are not trusted.`
          : "No other active Owner.",
        "Sign in, then review Staff & roles and the audit log, and rotate any exposed keys (secrets runbook).",
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "OWNER_RECOVERY_NOT_OWNER") {
      deps.out("No Owner account has that email. Nothing was changed.");
      return 3;
    }
    if (code === "OWNER_RECOVERY_ACTIVE_OWNER") {
      deps.out(
        "Another Owner is active: that Owner can reset access in the admin. If that Owner is not " +
          "trusted (compromised), rerun with --despite-active-owner. Nothing was changed.",
      );
      return 3;
    }
    deps.out(
      "Recovery failed; nothing was changed. Check database connectivity and configuration.",
    );
    return 1;
  }
}
