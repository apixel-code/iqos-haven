// Representative load, query and payload test (roadmap step 121, ADR 0085):
//   pnpm infra:up && pnpm build && node scripts/load/load-test.cjs [--out <dir>] [--keep]
// Seeds a launch-sized catalogue on a fresh ih_test_* schema of the TEST database, starts the
// built API on the budget profile (scripts/load/api-server.cjs, its own process) with the
// worker's relay and consumers, then runs, in order:
//   1. history: orders placed through the real checkout, so admin lists have data;
//   2. mixed load: shoppers browsing with think time, some checking out, staff reading lists;
//   3. contention: simultaneous orders for the last units and for a one-use coupon;
//   4. queue outage: the queue Redis stopped during checkout, then started; effects must drain.
// It records per-route p50/p95/p99, errors, API pool waits and lock waits, PostgreSQL plans of
// statements over 100 ms (auto_explain, enabled on the test database for the run only), and the
// architecture targets (read p95 < 300 ms, checkout p95 < 800 ms). Results: <out>/load-results.json.
"use strict";
const { spawn, execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { randomBytes, randomUUID, generateKeyPairSync } = require("node:crypto");
const { mkdirSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const api = createRequire(path.join(root, "apps/api/package.json"));
const config = api("@ih/config");
const { createDatabase, createPool, stockReconciliationMismatches } = api("@ih/db");
const { applyMigrations } = api("@ih/db/testing");
const platform = api("@ih/platform");

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const OUT = path.resolve(arg("--out", path.join(root, ".load")));
const SCALE = {
  brands: 30,
  categories: 6,
  products: 600,
  areas: 40,
  historyOrders: Number(arg("--history", 600)),
  historyConcurrency: 6,
  shoppers: Number(arg("--shoppers", 50)),
  staff: 2,
  mixedSeconds: Number(arg("--seconds", 120)),
  checkoutShare: 0.08,
  outageSeconds: 20,
};
const STORE = "https://shop.load-check.test";
const ADMIN = "https://admin.load-check.test";
const POLICY = "load-1";
const PASSWORD = "copper-lantern-river-71";
const DOCKER = process.env.QA_DOCKER ?? "docker";
const PG_CONTAINER = process.env.QA_PG_CONTAINER ?? "iqos-haven-postgres-1";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : 0;

// --- Measurements --------------------------------------------------------------------------
const samples = new Map(); // phase|route -> { ms: [], status: {} }
let phase = "setup";
const stamp = Date.now();
const progress = (text) => console.log(`[${Math.round((Date.now() - stamp) / 1000)}s] ${text}`);
async function timed(route, request) {
  const key = `${phase}|${route}`;
  if (!samples.has(key)) samples.set(key, { ms: [], status: {} });
  const entry = samples.get(key);
  const started = performance.now();
  let status = 0;
  let body = null;
  try {
    const response = await request();
    status = response.status;
    body = await response.text();
  } catch {
    status = -1;
  }
  entry.ms.push(performance.now() - started);
  entry.status[status] = (entry.status[status] ?? 0) + 1;
  return { status, body };
}
const poolSamples = [];
const lockSamples = [];
function summary() {
  const rows = [];
  for (const [key, entry] of samples) {
    const [p, route] = key.split("|");
    const sorted = [...entry.ms].sort((a, b) => a - b);
    rows.push({
      phase: p,
      route,
      count: sorted.length,
      p50: Math.round(pct(sorted, 50)),
      p95: Math.round(pct(sorted, 95)),
      p99: Math.round(pct(sorted, 99)),
      max: Math.round(sorted.at(-1) ?? 0),
      status: entry.status,
    });
  }
  return rows;
}

// A run that stops making progress fails instead of hanging (it still cleans up).
const emergency = [];
const WATCHDOG_MS = 20 * 60_000;
async function main() {
  const watchdog = setTimeout(() => {
    console.error(`watchdog: no result after ${WATCHDOG_MS / 60_000} minutes in phase ${phase}`);
    // Stop the server, reset the database settings and drop the schema, then fail.
    for (const step of emergency.reverse())
      try {
        step();
      } catch {
        /* best effort */
      }
    process.exit(1);
  }, WATCHDOG_MS);
  watchdog.unref();
  process.chdir(root);
  config.loadLocalEnvFile();
  const { DATABASE_TEST_URL } = config.loadEnv(config.integrationTestEnvSchema);
  config.assertTestDatabase(DATABASE_TEST_URL, process.env.DATABASE_URL);
  const database = new URL(DATABASE_TEST_URL).pathname.slice(1);
  const schema = "ih_test_" + randomUUID().replaceAll("-", "");
  const pool = createPool({
    connectionString: DATABASE_TEST_URL,
    applicationName: "ih-load-seed",
    searchPath: schema,
  });
  const db = createDatabase(pool, { schema });
  const q = (sql, params = []) => pool.query(sql, params);
  const psql = (sql) =>
    execFileSync(DOCKER, [
      "exec",
      "-i",
      PG_CONTAINER,
      "psql",
      "-U",
      "ih_owner",
      "-d",
      database,
      "-Atc",
      sql,
    ]).toString();
  const cleanup = [];
  let server;
  try {
    mkdirSync(OUT, { recursive: true });
    await applyMigrations(pool, schema);

    // --- Dataset ------------------------------------------------------------------------------
    const role = await db.role.findUniqueOrThrow({ where: { key: "owner" } });
    const hasher = new platform.Argon2PasswordHasher({
      memoryKib: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    const owner = await db.staffUser.create({
      data: {
        email: "load-owner@iqoshaven.test",
        name: "Load Owner",
        roleId: role.id,
        passwordHash: await hasher.hash(PASSWORD),
      },
    });
    await q(
      `INSERT INTO brands (name, slug, active, sort_order)
      SELECT 'Load Brand ' || i, 'load-brand-' || i, true, i FROM generate_series(1, $1) i`,
      [SCALE.brands],
    );
    await q(
      `INSERT INTO categories (name, slug, active, sort_order)
      SELECT 'Load Category ' || i, 'load-category-' || i, true, i FROM generate_series(1, $1) i`,
      [SCALE.categories],
    );
    // 3 of 4 disposables, 1 in 10 a draft; prices AED 35–230.
    await q(
      `WITH b AS (SELECT id, row_number() OVER (ORDER BY sort_order) AS n FROM brands),
            c AS (SELECT id, row_number() OVER (ORDER BY sort_order) AS n FROM categories)
       INSERT INTO products (name, slug, brand_id, category_id, type, puff_count, base_price_fils,
         status, description, is_new)
       SELECT 'Load ' || (CASE WHEN i % 4 = 0 THEN 'Kit ' ELSE 'Pod ' END) || i,
         'load-product-' || i, b.id, c.id,
         CASE WHEN i % 4 = 0 THEN 'kit' ELSE 'disposable' END,
         CASE WHEN i % 4 = 0 THEN NULL ELSE 3000 + (i % 10) * 1000 END,
         3500 + (i % 40) * 500,
         CASE WHEN i % 10 = 0 THEN 'draft' ELSE 'published' END,
         repeat('A representative product description. ', 8), i % 7 = 0
       FROM generate_series(1, $1) i
       JOIN b ON b.n = 1 + (i % $2) JOIN c ON c.n = 1 + (i % $3)`,
      [SCALE.products, SCALE.brands, SCALE.categories],
    );
    await q(`INSERT INTO product_options (product_id, name, allowed_values, sort_order)
      SELECT id, CASE WHEN type = 'kit' THEN 'colour' ELSE 'flavour' END,
        CASE WHEN type = 'kit' THEN '["black","silver","blue"]'::jsonb
             ELSE '["mint","ice","mango","grape","berry","cola"]'::jsonb END, 0
      FROM products`);
    await q(`INSERT INTO variants (product_id, sku, attributes, active, is_default, price_override_fils)
      SELECT p.id, upper('LD-' || substr(p.slug, 14) || '-' || k),
        jsonb_build_object(o.name, o.allowed_values ->> ((k + substr(p.slug, 14)::int) % jsonb_array_length(o.allowed_values))),
        true, k = 0, CASE WHEN k = 2 AND p.type = 'disposable' THEN p.base_price_fils + 500 END
      FROM products p JOIN product_options o ON o.product_id = p.id, generate_series(0, 2) k`);
    // Stock 200 each, except the third option of every 25th product (sold out, still shown).
    await q(`INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id)
      SELECT v.id, 200, 200, 'INITIAL_STOCK', gen_random_uuid()::text FROM variants v
      JOIN products p ON p.id = v.product_id
      WHERE NOT (v.sku LIKE '%-2' AND substr(p.slug, 14)::int % 25 = 0)`);
    // The last-units product for the contention phase.
    const last = (
      await q(`WITH p AS (
          INSERT INTO products (name, slug, brand_id, category_id, type, puff_count, base_price_fils, status)
          SELECT 'Load Last Units', 'load-last-units', (SELECT id FROM brands LIMIT 1),
            (SELECT id FROM categories LIMIT 1), 'disposable', 5000, 4000, 'published' RETURNING id)
        INSERT INTO variants (product_id, sku, active, is_default) SELECT id, 'LD-LAST', true, true FROM p
        RETURNING id`)
    ).rows[0].id;
    await q(
      `INSERT INTO stock_movements (variant_id, delta, balance_after, reason, command_id)
       VALUES ($1, 3, 3, 'INITIAL_STOCK', $2)`,
      [last, randomUUID()],
    );
    const emirates = [
      "dubai",
      "sharjah",
      "abu_dhabi",
      "ajman",
      "umm_al_quwain",
      "ras_al_khaimah",
      "fujairah",
    ];
    for (let i = 1; i <= SCALE.areas; i++)
      await db.deliveryArea.create({
        data: {
          code: `load_area_${i}`,
          name: `Load Area ${i}`,
          emirate: emirates[i % emirates.length],
          active: true,
          updatedBy: owner.id,
        },
      });
    await db.setting.create({
      data: {
        key: "delivery",
        updatedBy: owner.id,
        value: { flatFeeFils: 1500, etaText: "Same or next day", freeThresholdFils: null },
      },
    });
    await db.coupon.create({
      data: { code: "LOAD10", percentBps: 1000, active: true, updatedBy: owner.id },
    });
    await db.coupon.create({
      data: { code: "ONEUSE", percentBps: 1500, active: true, usageLimit: 1, updatedBy: owner.id },
    });
    const visible = (
      await q(`SELECT v.id, p.slug, p.type, b.slug AS brand FROM variants v
        JOIN products p ON p.id = v.product_id JOIN brands b ON b.id = p.brand_id
        WHERE p.status = 'published' AND v.stock_on_hand > 0 AND v.sku <> 'LD-LAST'`)
    ).rows;
    const areas = (await q("SELECT id FROM delivery_areas")).rows.map((row) => row.id);
    const dataset = {
      brands: SCALE.brands,
      categories: SCALE.categories,
      products: Number((await q("SELECT count(*) FROM products")).rows[0].count),
      variants: Number((await q("SELECT count(*) FROM variants")).rows[0].count),
      areas: SCALE.areas,
    };
    console.log(`DATASET ${JSON.stringify(dataset)} schema=${schema}`);

    // --- Server -------------------------------------------------------------------------------
    const pair = generateKeyPairSync("ed25519");
    const seed = pair.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
    const signer = platform.ageTicketSigner("k1", seed.toString("base64url"));
    const cookie = `${platform.AGE_COOKIE}=${platform.signAgeTicket(signer, { policyVersion: POLICY, ttlSeconds: 3600 }).ticket}`;
    // Plans of statements over 100 ms, for connections opened from now on (reset in finally).
    psql(`ALTER DATABASE ${database} SET session_preload_libraries = 'auto_explain'`);
    psql(`ALTER DATABASE ${database} SET auto_explain.log_min_duration = '100ms'`);
    psql(`ALTER DATABASE ${database} SET auto_explain.log_analyze = on`);
    const resetSettings = () => {
      for (const setting of [
        "session_preload_libraries",
        "auto_explain.log_min_duration",
        "auto_explain.log_analyze",
      ])
        psql(`ALTER DATABASE ${database} RESET ${setting}`);
    };
    cleanup.push(resetSettings);
    emergency.push(resetSettings);
    emergency.push(() =>
      execFileSync(DOCKER, [
        "exec",
        "-i",
        PG_CONTAINER,
        "psql",
        "-U",
        "ih_owner",
        "-d",
        database,
        "-Atc",
        `DROP SCHEMA IF EXISTS "${schema}" CASCADE`,
      ]),
    );
    const logsSince = new Date().toISOString();
    server = spawn(process.execPath, [path.join(__dirname, "api-server.cjs"), schema], {
      env: {
        ...process.env,
        LOAD_AGE_POLICY: POLICY,
        LOAD_AGE_PUBLIC_KEYS: `k1:${platform.ageTicketPublicKey(signer)}`,
        LOAD_STORE_ORIGIN: STORE,
        LOAD_ADMIN_ORIGIN: ADMIN,
        LOAD_CONFIRMATION_KEYS: `confirmation:c1:${randomBytes(32).toString("base64url")}`,
        LOAD_QUOTE_KEYS: `quote:t1:${randomBytes(32).toString("base64url")}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    emergency.push(() => server.kill("SIGKILL"));
    let serverErr = "";
    server.stderr.on("data", (chunk) => (serverErr = (serverErr + chunk).slice(-4000)));
    const base = await new Promise((resolve, reject) => {
      let buffer = "";
      server.stdout.on("data", (chunk) => {
        buffer += chunk;
        for (const line of buffer.split("\n").slice(0, -1)) {
          if (line.startsWith("READY ")) resolve(line.slice(6).trim());
          const pool = /^POOL (\d+) (\d+) (\d+)/.exec(line);
          if (pool)
            poolSamples.push({
              phase,
              total: +pool[1],
              idle: +pool[2],
              waiting: +pool[3],
            });
        }
        buffer = buffer.split("\n").at(-1);
      });
      server.once("exit", (code) => reject(new Error(`server exited ${code}: ${serverErr}`)));
    });
    console.log(`SERVING ${base}`);
    const lockTimer = setInterval(async () => {
      try {
        const row = (
          await q(`SELECT count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS locks,
              count(*) FILTER (WHERE state = 'active')::int AS active,
              count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_tx
            FROM pg_stat_activity WHERE application_name IN ('ih-load-api', 'ih-load-worker')`)
        ).rows[0];
        lockSamples.push({ phase, ...row });
      } catch {
        /* sampling only */
      }
    }, 500);
    cleanup.push(() => clearInterval(lockTimer));

    // --- Requests -------------------------------------------------------------------------------
    let ipSerial = 0;
    const nextIp = () => {
      ipSerial++;
      return `10.${(ipSerial >> 16) & 255}.${(ipSerial >> 8) & 255}.${ipSerial & 255}`;
    };
    let phoneSerial = 0;
    const phone = () =>
      "05" +
      String(1000000 + ++phoneSerial)
        .padStart(8, "0")
        .slice(-8);
    const shopperHeaders = (ip) => ({ cookie, "x-ih-client-ip": ip });
    const get = (route, url, ip) =>
      timed(route, () =>
        fetch(base + url, { headers: shopperHeaders(ip), signal: AbortSignal.timeout(30_000) }),
      );
    const post = (route, url, body, ip, extra = {}) =>
      timed(route, () =>
        fetch(base + url, {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          headers: {
            ...shopperHeaders(ip),
            origin: STORE,
            "content-type": "application/json",
            ...extra,
          },
          body: JSON.stringify(body),
        }),
      );
    async function checkout(ip, lines, couponCode = null, route = "checkout") {
      const areaId = pick(areas);
      const quoted = await post(
        `${route}:quote`,
        "/v1/store/cart/quote",
        { lines, areaId, couponCode },
        ip,
      );
      if (quoted.status !== 200) return { status: quoted.status, stage: "quote" };
      const token = JSON.parse(quoted.body).quote.token;
      const placed = await post(
        `${route}:order`,
        "/v1/store/orders",
        {
          contact: { name: "Load Shopper", phone: phone() },
          address: { areaId, type: "apartment", building: "Load Tower", unit: "1204" },
          lines,
          couponCode,
          quoteToken: token,
          ageConfirmed: true,
        },
        ip,
        { "idempotency-key": randomBytes(24).toString("base64url") },
      );
      return { status: placed.status, stage: "order", body: placed.body };
    }
    const cartOf = () => {
      const count = 1 + Math.floor(Math.random() * 3);
      const chosen = new Map();
      while (chosen.size < count) chosen.set(pick(visible).id, 1 + Math.floor(Math.random() * 2));
      return [...chosen].map(([variantId, quantity]) => ({ variantId, quantity }));
    };

    // 1. History through the real checkout.
    phase = "history";
    progress("phase history");
    let placed = 0;
    await Promise.all(
      Array.from({ length: SCALE.historyConcurrency }, async () => {
        while (placed < SCALE.historyOrders) {
          placed++;
          await checkout(nextIp(), cartOf(), Math.random() < 0.2 ? "LOAD10" : null);
        }
      }),
    );

    // 2. Mixed load.
    const login = await fetch(base + "/v1/auth/login", {
      method: "POST",
      headers: {
        origin: ADMIN,
        "content-type": "application/json",
        "x-ih-client-ip": "10.255.0.1",
      },
      body: JSON.stringify({ email: "load-owner@iqoshaven.test", password: PASSWORD }),
    });
    if (login.status !== 200) throw new Error(`admin sign-in ${login.status}`);
    const admin = login.headers.get("set-cookie").split(";")[0];
    const orderIds = (await q("SELECT id FROM orders ORDER BY created_at DESC LIMIT 200")).rows.map(
      (row) => row.id,
    );
    phase = "mixed";
    progress("phase mixed");
    const terms = ["mint", "ice", "load pod", "kit", "grape", "brand 7", "berry", "cola", "zzz"];
    const until = Date.now() + SCALE.mixedSeconds * 1000;
    const think = () => sleep(500 + Math.random() * 1500);
    const shoppers = Array.from({ length: SCALE.shoppers }, async () => {
      const ip = nextIp();
      while (Date.now() < until) {
        const item = pick(visible);
        await get("store:home", "/v1/store/content/home", ip);
        await think();
        await get(
          "store:listing",
          pick([
            "/v1/store/products?sort=newest",
            "/v1/store/products?type=disposable&sort=price_asc",
            `/v1/store/products?brand=${item.brand}`,
            "/v1/store/products?type=kit&limit=48",
          ]),
          ip,
        );
        await think();
        await get("store:search", `/v1/store/search?q=${encodeURIComponent(pick(terms))}`, ip);
        await think();
        await get("store:product", `/v1/store/products/${item.slug}`, ip);
        await think();
        const lines = cartOf();
        await get(
          "store:cart-lines",
          `/v1/store/cart/lines?${lines.map((line) => `variant=${line.variantId}`).join("&")}`,
          ip,
        );
        await think();
        if (Math.random() < SCALE.checkoutShare / 0.2) {
          await checkout(ip, lines);
          await think();
        }
      }
    });
    const staff = Array.from({ length: SCALE.staff }, async () => {
      const headers = { cookie: admin, "x-ih-client-ip": "10.255.0.2" };
      while (Date.now() < until) {
        await timed("admin:orders", () =>
          fetch(base + "/v1/admin/orders?limit=25", {
            headers,
            signal: AbortSignal.timeout(30_000),
          }),
        );
        await timed("admin:order", () =>
          fetch(base + `/v1/admin/orders/${pick(orderIds)}`, {
            headers,
            signal: AbortSignal.timeout(30_000),
          }),
        );
        await timed("admin:dashboard", () =>
          fetch(base + "/v1/admin/dashboard", { headers, signal: AbortSignal.timeout(30_000) }),
        );
        await timed("admin:customers", () =>
          fetch(base + "/v1/admin/customers?limit=25", {
            headers,
            signal: AbortSignal.timeout(30_000),
          }),
        );
        await timed("admin:inventory", () =>
          fetch(base + "/v1/admin/inventory?state=low&limit=50", {
            headers,
            signal: AbortSignal.timeout(30_000),
          }),
        );
        await sleep(2000);
      }
    });
    await Promise.all([...shoppers, ...staff]);

    // 3. Contention.
    phase = "contention";
    progress("phase contention");
    const lastResults = await Promise.all(
      Array.from({ length: 20 }, () =>
        checkout(nextIp(), [{ variantId: last, quantity: 1 }], null, "last-unit"),
      ),
    );
    const couponResults = await Promise.all(
      Array.from({ length: 10 }, () => checkout(nextIp(), cartOf(), "ONEUSE", "one-use-coupon")),
    );
    const contention = {
      lastUnits: {
        attempts: 20,
        placed: lastResults.filter((r) => r.status === 201).length,
        stockAfter: Number(
          (await q("SELECT stock_on_hand FROM variants WHERE id=$1", [last])).rows[0].stock_on_hand,
        ),
        statuses: lastResults.map((r) => `${r.stage}:${r.status}`),
      },
      oneUseCoupon: {
        attempts: 10,
        placed: couponResults.filter((r) => r.status === 201).length,
        redemptions: Number(
          (await q("SELECT active_redemptions FROM coupons WHERE code='ONEUSE'")).rows[0]
            .active_redemptions,
        ),
        statuses: couponResults.map((r) => `${r.stage}:${r.status}`),
      },
    };

    // 4. Queue outage during checkout.
    phase = "outage";
    progress("phase outage");
    const before = Number((await q("SELECT count(*) FROM orders")).rows[0].count);
    execFileSync(DOCKER, ["compose", "stop", "redis-queue"], { stdio: "ignore" });
    const outageUntil = Date.now() + SCALE.outageSeconds * 1000;
    let restarted = false;
    try {
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (Date.now() < outageUntil) {
            await checkout(nextIp(), cartOf(), null, "outage");
            await sleep(300);
          }
        }),
      );
    } finally {
      execFileSync(DOCKER, ["compose", "start", "redis-queue"], { stdio: "ignore" });
      restarted = true;
    }
    const outageOrders = Number((await q("SELECT count(*) FROM orders")).rows[0].count) - before;
    const drainStarted = Date.now();
    let pendingEffects = -1;
    // Up to 8 minutes: a job lost with Redis is re-enqueued by the reconciler after 5–6 minutes.
    for (let i = 0; i < 480; i++) {
      pendingEffects = Number(
        (
          await q(`SELECT
              -- An event is finished when completed; its dispatch mark may stay empty when the queue
              -- answer was lost but the job ran (the relay ignores completed events).
              (SELECT count(*) FROM outbox_events WHERE completed_at IS NULL) +
              (SELECT count(*) FROM consumer_effects WHERE status NOT IN ('completed', 'skipped')) AS n`)
        ).rows[0].n,
      );
      if (pendingEffects === 0) break;
      if (i % 30 === 0) progress(`draining: ${pendingEffects} unfinished`);
      await sleep(1000);
    }
    const outage = {
      seconds: SCALE.outageSeconds,
      ordersPlacedDuringOutage: outageOrders,
      redisRestarted: restarted,
      drainSeconds: pendingEffects === 0 ? Math.round((Date.now() - drainStarted) / 1000) : null,
      pendingEffectsAtEnd: pendingEffects,
    };

    progress(`outage done: ${JSON.stringify({ outageOrders, pendingEffects })}`);
    // --- Results ------------------------------------------------------------------------------
    phase = "done";
    progress("phase done");
    const totals = (
      await q(`SELECT (SELECT count(*) FROM orders)::int AS orders,
          (SELECT count(*) FROM customers)::int AS customers,
          (SELECT count(*) FROM stock_movements)::int AS movements`)
    ).rows[0];
    const mismatches = await stockReconciliationMismatches(db);
    const tables = (
      await q(
        `SELECT relname AS table, seq_scan, seq_tup_read, idx_scan, n_live_tup AS rows
        FROM pg_stat_user_tables WHERE schemaname = $1 AND seq_scan > 0
        ORDER BY seq_tup_read DESC LIMIT 12`,
        [schema],
      )
    ).rows;
    const rows = summary();
    const route = (name) => rows.filter((r) => r.phase === "mixed" && r.route === name);
    const readRows = rows.filter((r) => r.phase === "mixed" && r.route.startsWith("store:"));
    const readAll = readRows
      .flatMap((r) => samples.get(`mixed|${r.route}`).ms)
      .sort((a, b) => a - b);
    const orderAll = rows
      .filter((r) => r.phase === "mixed" && r.route === "checkout:order")
      .flatMap((r) => samples.get(`mixed|${r.route}`).ms)
      .sort((a, b) => a - b);
    const byPhase = (list, key) => {
      const out = {};
      for (const item of list) {
        out[item.phase] ??= { max: 0, sum: 0, n: 0 };
        out[item.phase].max = Math.max(out[item.phase].max, item[key]);
        out[item.phase].sum += item[key];
        out[item.phase].n += 1;
      }
      return Object.fromEntries(
        Object.entries(out).map(([k, v]) => [k, { max: v.max, mean: +(v.sum / v.n).toFixed(2) }]),
      );
    };
    let slowPlans = "";
    try {
      slowPlans = execFileSync(DOCKER, ["logs", "--since", logsSince, PG_CONTAINER], {
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 256 * 1024 * 1024,
      })
        .toString()
        .split("\n")
        .filter((line) => /duration: \d/.test(line) || /Query Text|->|Plan|Rows|Scan/.test(line))
        .join("\n");
    } catch {
      /* logs are optional */
    }
    const slowCount = (slowPlans.match(/duration: [\d.]+ ms\s+plan:/g) ?? []).length;
    const results = {
      date: new Date().toISOString(),
      profile: "budget (one API process, in-process catalogue cache, local limiters, pool 10)",
      host: `${require("node:os").cpus()[0].model}, ${require("node:os").cpus().length} cores, local Docker PostgreSQL 18 and Redis`,
      dataset: { ...dataset, ...totals, historyOrders: SCALE.historyOrders },
      scenario: {
        shoppers: SCALE.shoppers,
        staff: SCALE.staff,
        seconds: SCALE.mixedSeconds,
        thinkMs: "500–2000 between steps",
        checkoutShare: SCALE.checkoutShare,
      },
      targets: {
        readP95: { target: 300, measured: Math.round(pct(readAll, 95)) },
        checkoutOrderP95: { target: 800, measured: Math.round(pct(orderAll, 95)) },
      },
      routes: rows,
      pool: byPhase(poolSamples, "waiting"),
      poolOpen: byPhase(poolSamples, "total"),
      lockWaits: byPhase(lockSamples, "locks"),
      idleInTransaction: byPhase(lockSamples, "idle_tx"),
      contention,
      outage,
      reconciliation: { mismatches: mismatches.length },
      seqScans: tables,
      slowStatements: slowCount,
    };
    writeFileSync(path.join(OUT, "load-results.json"), JSON.stringify(results, null, 2));
    writeFileSync(path.join(OUT, "slow-plans.log"), slowPlans);
    console.log(
      JSON.stringify(
        {
          targets: results.targets,
          contention,
          outage,
          reconciliation: results.reconciliation,
          slowStatements: slowCount,
        },
        null,
        2,
      ),
    );
    for (const row of rows.filter((r) => r.phase === "mixed"))
      console.log(
        `${row.route.padEnd(22)} n=${String(row.count).padStart(5)} p50=${row.p50} p95=${row.p95} p99=${row.p99} max=${row.max} ${JSON.stringify(row.status)}`,
      );
    void route;
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((done) => server.once("exit", done));
    }
    for (const step of cleanup.reverse()) {
      try {
        await step();
      } catch (error) {
        console.error("cleanup:", error.message);
      }
    }
    await db.$disconnect();
    if (!process.argv.includes("--keep")) await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    else console.log(`KEPT ${schema}`);
    await pool.end();
  }
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
