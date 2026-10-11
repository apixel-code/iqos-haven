// Age-boundary end-to-end check (roadmap step 64, Milestone 5 gate). Runs the REAL built API on
// an isolated `ih_test_*` schema, the REAL built storefront and the REAL gateway container, then
// proves over HTTP through the gateway that:
//   - without a valid age ticket no page, RSC request or API route gives any product data;
//   - forged headers, cookies, tickets from another key and crawler user agents change nothing;
//   - after a verified shopper has browsed (warming the API's catalogue cache) the same
//     unverified requests are still refused;
//   - a verified shopper can browse, search, open a product and refresh a cart;
//   - admin and internal API routes are not reachable from the storefront origin.
// Needs `pnpm build`, Docker, and the local PostgreSQL/Redis/MinIO (`pnpm infra:up`).
// `--serve` keeps the stack running and prints the URL and a cookie for a manual browser pass.
const { spawn, spawnSync } = require("node:child_process");
const { generateKeyPairSync, randomBytes, randomUUID } = require("node:crypto");
const { createRequire } = require("node:module");
const net = require("node:net");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const api = createRequire(root + "/apps/api/package.json");
api("reflect-metadata");
process.chdir(root);
const config = api("@ih/config");
const { adjustStock, createDatabase, createPool } = api("@ih/db");
const { applyMigrations } = api("@ih/db/testing");
const { Argon2PasswordHasher, ageTicketSigner, signAgeTicket } = api("@ih/platform");
const IMAGE = require(root + "/infra/images.lock.json").caddy;

config.loadLocalEnvFile();
const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);

const ORIGIN = "https://shop.gate-check.test";
const POLICY = "gate-check";
const NAMES = ["Gatecheck Halo", "Gatecheck Hidden"];
const WHATSAPP = "+971500000042";
const SECRET_TEMPLATE = "Gatecheck private template";
const SECRET_RECIPIENT = "gatecheck-owner@iqoshaven.test";
let failures = 0;
let passed = 0;
const check = (ok, name, detail = "") => {
  if (ok) passed++;
  else {
    failures++;
    console.error(`FAIL ${name}${detail ? " — " + detail : ""}`);
  }
};
const freePort = () =>
  new Promise((done, fail) => {
    const server = net.createServer();
    server.once("error", fail);
    server.listen(0, "0.0.0.0", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
const rawKey = (key, type) =>
  key.export({ format: "der", type }).subarray(-32).toString("base64url");
const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });

async function main() {
  const namespace = "ih_test_" + randomUUID().replaceAll("-", "");
  const pool = createPool({
    connectionString: DATABASE_TEST_URL,
    applicationName: "ih-gate-check",
    searchPath: namespace,
  });
  const db = createDatabase(pool, { schema: namespace });
  const cleanup = [];
  let exitCode = 1;
  try {
    // --- Seed: one published product a shopper may see, one draft nobody may see ---
    await applyMigrations(pool, namespace);
    cleanup.push(async () => {
      await db.$disconnect();
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    });
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    const staff = await db.staffUser.create({
      data: {
        email: "gate-check@iqoshaven.test",
        name: "Gate Check",
        roleId: role.id,
        passwordHash: await new Argon2PasswordHasher({
          memoryKib: 19456,
          timeCost: 2,
          parallelism: 1,
        })
          // Random per run: the API listens on all interfaces for the gateway container, and
          // nobody, including this script, ever signs in as this account.
          .hash(randomBytes(24).toString("base64url")),
      },
    });
    const brand = await db.brand.create({
      data: { name: "Gatebrand", slug: "gatebrand", active: true },
    });
    const category = await db.category.create({
      data: { name: "Gatecategory", slug: "gatecategory", active: true },
    });
    const seed = async (name, slug, published) => {
      const product = await db.product.create({
        data: {
          name,
          slug,
          brandId: brand.id,
          categoryId: category.id,
          type: "disposable",
          puffCount: 7000,
          basePriceFils: 4900n,
          description: "Synthetic description.",
          specs: { extra: [] },
        },
      });
      await db.productOption.create({
        data: { productId: product.id, name: "flavour", allowedValues: ["grape", "mint"] },
      });
      const variants = [];
      for (const [index, flavour] of ["grape", "mint"].entries()) {
        const variant = await db.variant.create({
          data: {
            productId: product.id,
            sku: `GATE-${slug.toUpperCase().slice(0, 20)}-${index}`,
            attributes: { flavour },
            active: true,
            isDefault: index === 0,
          },
        });
        if (index === 0)
          await adjustStock(db, { actorId: staff.id, requestId: randomUUID() }, variant.id, {
            commandId: randomUUID(),
            delta: 5,
            reason: "RESTOCK",
          });
        variants.push(variant);
      }
      if (published)
        await db.product.update({
          where: { id: product.id },
          data: { status: "published", taxTreatmentRef: "synthetic-vat", taxTreatmentVersion: 1 },
        });
      return { ...product, variants };
    };
    // Owner settings: only the WhatsApp number may ever reach a shopper, and only a verified one.
    await db.setting.create({
      data: {
        key: "whatsapp",
        updatedBy: staff.id,
        value: {
          number: WHATSAPP,
          templates: { orderConfirmation: SECRET_TEMPLATE, statusUpdate: null, support: null },
        },
      },
    });
    await db.setting.create({
      data: {
        key: "notifications",
        updatedBy: staff.id,
        value: { inApp: true, newOrderEmail: { enabled: true, recipients: [SECRET_RECIPIENT] } },
      },
    });
    const visible = await seed(NAMES[0], "gatecheck-halo", true);
    const hidden = await seed(NAMES[1], "gatecheck-hidden", false);

    // --- Real API, real storefront, real gateway ---
    const pair = generateKeyPairSync("ed25519");
    const signer = ageTicketSigner("gate", rawKey(pair.privateKey, "pkcs8"));
    const publicKeys = `gate:${rawKey(pair.publicKey, "spki")}`;
    const [apiPort, storePort] = [await freePort(), await freePort()];
    // Storage settings the same way the API integration tests take them (local .env or CI env).
    const storageEnv = config.loadEnv(config.storageIntegrationTestEnvSchema);
    const env = config.apiEnvSchema.parse({
      QUEUE_REDIS_URL: process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379",
      ...storageEnv,
      S3_FORCE_PATH_STYLE: "true",
      NODE_ENV: "development",
      APP_ENV: "development",
      LOG_LEVEL: "warn",
      DATABASE_URL: DATABASE_TEST_URL,
      ARGON2_MEMORY_KIB: 19456,
      ARGON2_TIME_COST: 2,
      ARGON2_PARALLELISM: 1,
      AGE_TICKET_PUBLIC_KEYS: publicKeys,
      AGE_POLICY_VERSION: POLICY,
    });
    const { createApp } = api(root + "/apps/api/dist/bootstrap.js");
    const app = await createApp(env, { pool, database: db });
    // All interfaces: the gateway container reaches the host through host.docker.internal.
    await app.listen(apiPort, "0.0.0.0");
    cleanup.push(() => app.close());

    let storeLog = "";
    const store = spawn(
      process.execPath,
      [path.join(root, "scripts/next-app.cjs"), "storefront", "start"],
      {
        cwd: path.join(root, "apps/storefront"),
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          APP_ENV: "staging",
          STOREFRONT_PORT: String(storePort),
          STOREFRONT_ORIGINS: ORIGIN,
          API_INTERNAL_URL: `http://127.0.0.1:${apiPort}`,
          AGE_POLICY_VERSION: POLICY,
          AGE_TICKET_KEY_ID: "gate",
          AGE_TICKET_PRIVATE_KEY: rawKey(pair.privateKey, "pkcs8"),
          AGE_TICKET_PUBLIC_KEYS: publicKeys,
        },
      },
    );
    store.stdout.on("data", (chunk) => (storeLog += chunk));
    store.stderr.on("data", (chunk) => (storeLog += chunk));
    cleanup.push(
      () =>
        new Promise((done) => {
          if (store.exitCode !== null) return done();
          store.once("exit", done);
          store.kill("SIGTERM");
          setTimeout(done, 5000).unref();
        }),
    );

    const container = "ih-gate-check-" + randomUUID().slice(0, 8);
    const run = docker(
      "run",
      "-d",
      "--rm",
      "--name",
      container,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      "127.0.0.1::8080",
      "-v",
      `${root}/infra/gateway/Caddyfile:/etc/caddy/Caddyfile:ro`,
      "-e",
      `STOREFRONT_UPSTREAM=host.docker.internal:${storePort}`,
      "-e",
      `ADMIN_UPSTREAM=host.docker.internal:${storePort}`,
      "-e",
      `API_UPSTREAM=host.docker.internal:${apiPort}`,
      `${IMAGE.image}@${IMAGE.digest}`,
    );
    if (run.status !== 0) throw new Error("gateway container failed to start: " + run.stderr);
    cleanup.push(() => void docker("stop", container));
    const gatewayPort = docker("port", container, "8080/tcp").stdout.trim().split(":").pop();
    const base = `http://127.0.0.1:${gatewayPort}`;

    const get = (target, headers = {}, method = "GET") =>
      fetch(base + target, { redirect: "manual", headers, method });
    let ready = false;
    for (let attempt = 0; attempt < 150 && !ready; attempt++) {
      if (store.exitCode !== null) break;
      try {
        ready = (await get("/age-check")).status === 200;
      } catch {
        // not up yet
      }
      if (!ready) await new Promise((done) => setTimeout(done, 200));
    }
    if (!ready) throw new Error("stack did not start through the gateway\n" + storeLog.slice(-800));

    // --- What "refused" means ---
    const leaks = (text) =>
      NAMES.some((name) => text.includes(name)) ||
      // The price as data or as text. A bare "4900" would also match random request IDs.
      /"price(?:From)?Fils":4900|AED 49/.test(text) ||
      text.includes(WHATSAPP) ||
      text.includes(WHATSAPP.slice(1));
    /** Never allowed in any response, verified or not. */
    const settingsLeak = (text) =>
      text.includes(SECRET_TEMPLATE) || text.includes(SECRET_RECIPIENT);
    const PAGES = [
      "/",
      "/shop",
      "/disposable-vapes",
      "/brands",
      "/brands/gatebrand",
      "/categories/gatecategory",
      "/search?q=gatecheck",
      "/p/gatecheck-halo",
      "/cart",
      "/wishlist",
      "/compare",
      "/_next/image?url=%2Fmedia%2Fgatecheck.webp&w=640&q=75",
    ];
    const API_ROUTES = [
      "/api/v1/store/info",
      "/api/v1/store/brands",
      "/api/v1/store/categories",
      "/api/v1/store/products",
      "/api/v1/store/products/gatecheck-halo",
      "/api/v1/store/search?q=gatecheck",
      "/api/v1/store/search/suggest?q=gatecheck",
      `/api/v1/store/cart/lines?variant=${visible.variants[0].id}`,
      "/api/v1/store/product-cards?slug=gatecheck-halo",
    ];
    async function refused(label, headers) {
      for (const target of PAGES)
        for (const extra of [{}, { rsc: "1", "next-router-prefetch": "1" }]) {
          const response = await get(target, { ...headers, ...extra });
          const body = await response.text();
          const location = response.headers.get("location") ?? "";
          const name = `${label}: page ${target}${extra.rsc ? " (RSC)" : ""}`;
          check(
            response.status === 307 && new URL(location, ORIGIN).pathname === "/age-check",
            `${name} redirects to the age check`,
            `${response.status} ${location}`,
          );
          check(!leaks(body) && !settingsLeak(body), `${name} carries no product or settings data`);
          check(
            /no-store/.test(response.headers.get("cache-control") ?? ""),
            `${name} is not cacheable`,
          );
        }
      for (const target of API_ROUTES) {
        const response = await get(target, headers);
        const body = await response.text();
        const name = `${label}: API ${target.split("?")[0]}`;
        check(response.status === 403, `${name} answers 403`, String(response.status));
        check(body.includes("AGE_VERIFICATION_REQUIRED"), `${name} says the age check is required`);
        check(!leaks(body) && !settingsLeak(body), `${name} carries no product or settings data`);
        check(
          /no-store/.test(response.headers.get("cache-control") ?? ""),
          `${name} is not cacheable`,
        );
      }
    }
    const otherKey = generateKeyPairSync("ed25519");
    const forgedTicket = signAgeTicket(
      ageTicketSigner("gate", rawKey(otherKey.privateKey, "pkcs8")),
      { policyVersion: POLICY, ttlSeconds: 600 },
    ).ticket;
    const expiredTicket = signAgeTicket(signer, {
      policyVersion: POLICY,
      ttlSeconds: 60,
      now: Date.now() - 3_600_000,
    }).ticket;
    const otherPolicy = signAgeTicket(signer, { policyVersion: "older", ttlSeconds: 600 }).ticket;
    const ATTEMPTS = {
      "no cookie": {},
      "crawler user agent": { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" },
      "preview fetcher": { "user-agent": "facebookexternalhit/1.1" },
      "forged headers": {
        "x-age-verified": "true",
        "x-ih-age": "accepted",
        "x-ih-client-ip": "127.0.0.1",
      },
      "junk cookie": { cookie: "ih_age=accepted" },
      "ticket from another key": { cookie: `ih_age=${forgedTicket}` },
      "expired ticket": { cookie: `ih_age=${expiredTicket}` },
      "ticket for another policy": { cookie: `ih_age=${otherPolicy}` },
    };

    // 1. Cold: nothing has been verified yet.
    for (const [label, headers] of Object.entries(ATTEMPTS))
      await refused(`cold, ${label}`, headers);

    // 2. Accept through the gateway: the storefront signs, the cookie is HttpOnly and Secure.
    const noOrigin = await get("/api/age/accept", {}, "POST");
    check(noOrigin.status === 403, "accept without an Origin is refused", String(noOrigin.status));
    const accept = await fetch(base + "/api/age/accept", {
      method: "POST",
      redirect: "manual",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "return=%2Fp%2Fgatecheck-halo",
    });
    const setCookie = accept.headers.getSetCookie().find((value) => value.startsWith("ih_age=v1."));
    check(
      accept.status === 303 && accept.headers.get("location") === "/p/gatecheck-halo",
      "accept redirects to the local return path",
      `${accept.status} ${accept.headers.get("location")}`,
    );
    check(
      Boolean(setCookie) && /; Secure; HttpOnly; SameSite=Lax$/.test(setCookie),
      "accept sets an HttpOnly, Secure age cookie",
      setCookie?.replace(/=v1\.[^;]+/, "=<ticket>"),
    );
    const verified = { cookie: setCookie.split(";")[0] };

    if (process.argv.includes("--serve")) {
      console.log(`SERVING ${base}\nCOOKIE ${verified.cookie}\nVARIANT ${visible.variants[0].id}`);
      await new Promise((done) => process.once("SIGINT", done).once("SIGTERM", done));
      exitCode = 0;
      return;
    }

    // 3. A verified shopper browses, searches, opens the product and refreshes a cart.
    const page = async (target, expected, ...texts) => {
      const response = await get(target, verified);
      const html = (await response.text()).replaceAll("<!-- -->", "");
      check(
        response.status === expected,
        `verified ${target}: ${expected}`,
        String(response.status),
      );
      check(
        response.headers.get("cache-control") === "private, no-store",
        `verified ${target} is not cacheable`,
        response.headers.get("cache-control") ?? "",
      );
      for (const text of texts) check(html.includes(text), `verified ${target} shows "${text}"`);
      check(!html.includes(NAMES[1]), `verified ${target} never shows the draft product`);
      check(!settingsLeak(html), `verified ${target} shows no other Owner settings`);
      return html;
    };
    const homeHtml = await page("/", 200, "New in", NAMES[0], "Gatebrand", "Shop by category");
    check(
      homeHtml.includes(`https://wa.me/${WHATSAPP.slice(1)}?text=`),
      "a verified shopper's footer has the WhatsApp link with the configured number",
    );
    await page("/shop", 200, NAMES[0], "AED 49", "7K puffs · 2 options");
    await page("/brands/gatebrand", 200, NAMES[0]);
    await page("/search?q=gatecheck", 200, NAMES[0], "1</b> product");
    await page("/p/gatecheck-halo", 200, NAMES[0], "choose one", "grape", "mint", "Add to cart");
    await page("/p/gatecheck-hidden", 404);
    await page("/cart", 200, "Your cart");
    const apiJson = async (target, expected = 200) => {
      const response = await get(target, verified);
      const text = await response.text();
      check(
        response.status === expected,
        `verified API ${target.split("?")[0]}: ${expected}`,
        String(response.status),
      );
      check(
        !text.includes(NAMES[1]) && !text.includes("GATE-"),
        `verified API ${target.split("?")[0]} hides drafts and SKUs`,
      );
      return text;
    };
    const infoText = await apiJson("/api/v1/store/info");
    check(
      infoText === JSON.stringify({ whatsappNumber: WHATSAPP }),
      "store info is exactly the WhatsApp number",
      infoText,
    );
    check(
      (await apiJson("/api/v1/store/products")).includes(NAMES[0]),
      "product list through the gateway",
    );
    check(
      (await apiJson("/api/v1/store/products/gatecheck-halo")).includes('"available":true'),
      "product detail through the gateway",
    );
    check(
      (await apiJson("/api/v1/store/search/suggest?q=gate")).includes(NAMES[0]),
      "suggestions through the gateway",
    );
    const cartText = await apiJson(
      `/api/v1/store/cart/lines?variant=${visible.variants[0].id}&variant=${visible.variants[1].id}&variant=${hidden.variants[0].id}`,
    );
    const cart = JSON.parse(cartText);
    check(
      cart.lines.length === 2 && cart.lines.filter((line) => line.available).length === 1,
      "cart refresh through the gateway: visible variants only, stock as yes/no",
      cartText.slice(0, 200),
    );
    check(
      (
        await apiJson("/api/v1/store/product-cards?slug=gatecheck-halo&slug=gatecheck-hidden")
      ).includes('"requested":"gatecheck-halo"'),
      "saved-item cards through the gateway",
    );
    await apiJson("/api/v1/store/products/gatecheck-hidden", 404);

    // 4. Warm: the API's catalogue cache now holds what the verified shopper loaded.
    for (const [label, headers] of Object.entries(ATTEMPTS))
      await refused(`warm, ${label}`, headers);

    // 5. The storefront origin exposes nothing else of the API.
    for (const target of [
      "/api/v1/admin/products",
      "/api/v1/auth/me",
      "/api/v1/internal/revalidate",
      "/api/v1/health/ready",
      "/api/v1/store/../admin/products",
    ]) {
      const response = await get(target, verified);
      check(
        response.status === 404,
        `${target} is not reachable from the storefront origin`,
        String(response.status),
      );
    }

    // 6. Saying "under 18" ends access for that browser.
    const reject = await fetch(base + "/api/age/reject", {
      method: "POST",
      redirect: "manual",
      headers: { origin: ORIGIN, ...verified },
    });
    const cleared = reject.headers.getSetCookie();
    check(
      reject.status === 303 && cleared.some((value) => value.startsWith("ih_age=; Max-Age=0")),
      "reject clears the age cookie",
      cleared.join(" | "),
    );
    const marker = cleared.find((value) => value.startsWith("ih_age_restricted=1"));
    const afterReject = await get("/shop", { cookie: marker.split(";")[0] });
    check(
      afterReject.status === 307 &&
        new URL(afterReject.headers.get("location"), ORIGIN).pathname === "/restricted",
      "a rejected browser is sent to the restricted page",
      `${afterReject.status} ${afterReject.headers.get("location")}`,
    );
    exitCode = failures ? 1 : 0;
    // On failure, the storefront's own log usually names the cause.
    if (failures) console.error("storefront log (tail):\n" + storeLog.slice(-1500));
  } finally {
    for (const step of cleanup.reverse()) {
      try {
        await step();
      } catch (error) {
        console.error("cleanup:", error.message);
      }
    }
  }
  if (failures) console.error(`${failures} gate check(s) failed, ${passed} passed.`);
  else if (!process.argv.includes("--serve")) console.log(`${passed} gate checks passed.`);
  process.exit(exitCode);
}
main().catch((error) => {
  console.error("Gate check failed:", error.message);
  process.exit(1);
});
