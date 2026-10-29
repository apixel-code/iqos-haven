// Container entry for a Next standalone build (step 122). Validates the app's environment before
// the server starts, so a misconfigured release fails at boot instead of on the first request, and
// keeps the age-ticket signing key out of every process except the storefront.
const { loadEnv, storefrontEnvSchema, adminEnvSchema, ConfigurationError } = require("@ih/config");

const app = process.env.IH_NEXT_APP;
try {
  if (app !== "storefront" && app !== "admin") throw new Error("IH_NEXT_APP must be set");
  if (app === "admin") {
    delete process.env.AGE_TICKET_PRIVATE_KEY;
    delete process.env.AGE_TICKET_KEY_ID;
  }
  const env = loadEnv(app === "storefront" ? storefrontEnvSchema : adminEnvSchema);
  process.env.PORT = String(app === "storefront" ? env.STOREFRONT_PORT : env.ADMIN_PORT);
  process.env.HOSTNAME = "0.0.0.0";
} catch (error) {
  console.error(
    error instanceof ConfigurationError ? error.message : "Invalid app startup configuration",
  );
  process.exit(1);
}
require("./server.js");
