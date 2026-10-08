const { spawn } = require("node:child_process");
const {
  loadLocalEnvFile,
  loadEnv,
  storefrontEnvSchema,
  adminEnvSchema,
  ConfigurationError,
} = require("@ih/config");
const app = process.argv[2];
const action = process.argv[3];
try {
  if (!["storefront", "admin"].includes(app) || !["dev", "start"].includes(action))
    throw new Error("Invalid app launch");
  process.env.NODE_ENV = action === "dev" ? "development" : "production";
  loadLocalEnvFile();
  const env = loadEnv(app === "storefront" ? storefrontEnvSchema : adminEnvSchema);
  const port = app === "storefront" ? env.STOREFRONT_PORT : env.ADMIN_PORT;
  const child = spawn(
    process.execPath,
    [
      require.resolve("next/dist/bin/next", { paths: [process.cwd()] }),
      action,
      "--port",
      String(port),
      ...process.argv.slice(4),
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_ENV: action === "dev" ? "development" : "production",
        APP_ENV: env.APP_ENV,
      },
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.once("error", () => {
    console.error("Next app failed to start");
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} catch (error) {
  console.error(
    error instanceof ConfigurationError ? error.message : "Invalid app startup configuration",
  );
  process.exitCode = 1;
}
