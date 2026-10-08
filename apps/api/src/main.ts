import "reflect-metadata";
import { apiEnvSchema, ConfigurationError, loadEnv, loadLocalEnvFile } from "@ih/config";
import { createApp } from "./bootstrap";
async function main(): Promise<void> {
  loadLocalEnvFile();
  const env = loadEnv(apiEnvSchema);
  const app = await createApp(env);
  await app.listen(env.API_PORT, env.API_HOST);
}
main().catch((error: unknown) => {
  console.error(
    error instanceof ConfigurationError
      ? error.message
      : "API startup failed; inspect safe service diagnostics.",
  );
  process.exit(1);
});
