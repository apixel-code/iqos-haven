import { loadEnv, loadLocalEnvFile, passwordHashEnvFields } from "@ih/config";
import { Argon2PasswordHasher, argon2ParamsFromEnv } from "@ih/platform";
import { z } from "zod";

/**
 * Measures argon2id cost with the configured parameters on THIS machine (architecture §11:
 * benchmark on the production runtime). Aim for roughly 250–750 ms per hash on production
 * hardware while staying within login rate limits and memory budgets; then set
 * ARGON2_MEMORY_KIB / ARGON2_TIME_COST / ARGON2_PARALLELISM accordingly.
 */
async function main(): Promise<void> {
  loadLocalEnvFile();
  const env = loadEnv(z.object(passwordHashEnvFields));
  const params = argon2ParamsFromEnv(env);
  const hasher = new Argon2PasswordHasher(params);
  await hasher.hash("warm-up-only-not-a-secret");
  const samples: number[] = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    await hasher.hash("benchmark-only-not-a-secret");
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  process.stdout.write(
    `argon2id m=${params.memoryKib} KiB t=${params.timeCost} p=${params.parallelism}: ` +
      `median ${samples[2]!.toFixed(0)} ms (min ${samples[0]!.toFixed(0)}, max ${samples[4]!.toFixed(0)})\n`,
  );
}

main().catch(() => {
  console.error("Benchmark failed; check ARGON2_* settings.");
  process.exit(1);
});
