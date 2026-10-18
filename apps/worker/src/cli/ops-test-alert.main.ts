import { ConfigurationError, loadEnv, loadLocalEnvFile, workerEnvSchema } from "@ih/config";
import { createLogger } from "@ih/logger";
import { createEmailAdapter } from "../email";
import { OpsAlerter } from "../ops-monitor";

/**
 * `pnpm ops:test-alert` (step 125): sends one test alert to OPS_ALERT_RECIPIENTS through the
 * worker's own email path, so the recipients and the sender are proven before launch. Prints the
 * accepted/rejected counts only.
 */
async function main(): Promise<number> {
  loadLocalEnvFile();
  const env = loadEnv(workerEnvSchema);
  const log = createLogger({ service: "worker", level: "warn" });
  const email = createEmailAdapter(env, log);
  try {
    if (!env.OPS_ALERT_RECIPIENTS.length) {
      process.stdout.write("OPS_ALERT_RECIPIENTS is empty: alerts would reach the logs only.\n");
      return 1;
    }
    const result = await new OpsAlerter({
      adapter: email.adapter,
      from: env.EMAIL_FROM ?? "no-reply@iqoshaven.local",
      recipients: env.OPS_ALERT_RECIPIENTS,
      appEnv: env.APP_ENV,
      log,
    }).test();
    process.stdout.write(
      `Test alert handed to the email provider: ${result.accepted} accepted, ${result.rejected} rejected. ` +
        "Confirm it arrived in each inbox.\n",
    );
    return result.accepted > 0 && result.rejected === 0 ? 0 : 1;
  } finally {
    email.close();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      error instanceof ConfigurationError ? error.message : "Test alert could not be sent.",
    );
    process.exit(2);
  },
);
