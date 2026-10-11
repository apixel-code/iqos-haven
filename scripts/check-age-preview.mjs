// Age-boundary preview check (roadmap step 57, ADR 0026). Starts the BUILT storefront on a free
// port with a throwaway key pair and proves, over real HTTP, that a request without a valid age
// ticket gets only the generic store preview: no product name, image, price or JSON-LD, the same
// metadata for every User-Agent, and no header/cookie/query shortcut. Needs `pnpm build` first;
// no Docker or database. A stub stands in for the API so the catalogue pages can also be
// rendered for a verified shopper: the check then proves that what a verified shopper warmed is
// still refused to the next unverified request, and that the storefront forwards only the age
// ticket and the client address to the API.
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://shop.preview-check.test";
const RESTRICTED = [
  "/",
  "/shop",
  "/shop?brand=orbe&sort=price_asc",
  "/disposable-vapes",
  "/vape-kits",
  "/brands",
  "/categories/disposables",
  "/search?q=orbe+halo&brand=orbe&inStock=true",
  "/p/orbe-halo-7k",
  "/products/orbe-halo-7k-grape-ice",
  "/brands/orbe",
  "/cart",
  "/checkout",
  "/sitemap.xml",
  "/_next/image",
  "/_next/image?url=%2Fmedia%2Fhalo.webp&w=640&q=75",
  "/_next/image?url=https%3A%2F%2Fmedia.example%2Forbe-halo.webp&w=640&q=75",
  "/cart",
];
// Words from the product URLs above: they must never come back in a body or in metadata.
const PRODUCT_TOKENS = /halo|orbe|grape/i;
const AGENTS = {
  browser:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  bingbot: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  facebook: "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
  whatsapp: "WhatsApp/2.23.20.0",
  twitter: "Twitterbot/1.0",
  slack: "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  none: "",
};
// Anything that would mean catalogue data reached an unverified client.
const FORBIDDEN = [
  /application\/ld\+json/i,
  /\bAED\b/,
  /og:price|product:price|product:brand/i,
  /itemprop=/i,
  /"@type"/,
];

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
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

const pair = generateKeyPairSync("ed25519");
const raw = (key, type) => key.export({ format: "der", type }).subarray(-32).toString("base64url");
// --- Stub API: contract-shaped catalogue answers, and a record of what the storefront sent ---
const card = (name, overrides = {}) => ({
  slug: name.toLowerCase().replaceAll(" ", "-"),
  name,
  type: "disposable",
  brand: { name: "Orbe", slug: "orbe" },
  category: { name: "Disposables", slug: "disposables" },
  puffCount: 7000,
  isNew: false,
  priceFromFils: 4900,
  compareAtPriceFils: null,
  variantCount: 4,
  soldOut: false,
  image: null,
  ...overrides,
});
const CATALOGUE = {
  "/v1/store/brands": {
    items: [
      { name: "Orbe", slug: "orbe", description: "Synthetic brand story.", productCount: 2 },
      { name: "Empty Brand", slug: "empty-brand", description: "", productCount: 0 },
    ],
  },
  "/v1/store/categories": {
    items: [{ name: "Disposables", slug: "disposables", productCount: 2 }],
  },
};
const variantOf = (n, attributes, overrides = {}) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  attributes,
  isDefault: n === 1,
  priceFils: 4900,
  compareAtPriceFils: null,
  available: true,
  ...overrides,
});
const DETAIL = {
  slug: "orbe-halo-7k",
  name: "Orbe Halo 7K",
  type: "disposable",
  brand: { name: "Orbe", slug: "orbe" },
  category: { name: "Disposables", slug: "disposables" },
  puffCount: 7000,
  isNew: true,
  description: "Synthetic product description.",
  specs: {
    liquidMl: "12.5",
    batteryMah: 650,
    rechargeable: true,
    extra: [{ label: "Coil", value: "Mesh" }],
  },
  seo: { title: null, description: null },
  options: [
    { name: "flavour", values: ["grape ice", "mint"] },
    { name: "nicotine", values: ["20 mg", "50 mg"] },
  ],
  variants: [
    variantOf(
      1,
      { flavour: "grape ice", nicotine: "20 mg" },
      { priceFils: 4500, compareAtPriceFils: 5900 },
    ),
    variantOf(2, { flavour: "grape ice", nicotine: "50 mg" }),
    variantOf(3, { flavour: "mint", nicotine: "20 mg" }, { available: false }),
  ],
  soldOut: false,
  images: [],
};
const apiCalls = [];
let apiMode = "ok";
const stub = createHttpServer((request, response) => {
  const url = new URL(request.url, "http://stub");
  apiCalls.push({ path: url.pathname, search: url.search, headers: request.headers });
  const send = (status, body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (
    !/^ih_age=v1\.check\.[\w-]+\.[\w-]+$/.test(request.headers.cookie ?? "") ||
    apiMode === "refuse"
  )
    return send(403, { error: { code: "AGE_VERIFICATION_REQUIRED" } });
  if (apiMode === "down") return send(503, { error: { code: "SERVICE_UNAVAILABLE" } });
  if (url.searchParams.get("cursor") === "c3RhbGU")
    return send(400, { error: { code: "VALIDATION_ERROR" } });
  if (url.pathname === "/v1/store/products")
    return send(
      200,
      url.searchParams.has("cursor")
        ? { items: [card("Orbe Second Page")], nextCursor: null }
        : {
            items: [
              card("Orbe Halo Grape", {
                isNew: true,
                priceFromFils: 4500,
                compareAtPriceFils: 5900,
              }),
              card("Orbe Halo Mint", { soldOut: true, priceFromFils: 4950 }),
            ],
            nextCursor: "bmV4dC1wYWdl",
          },
    );
  // The product under its current slug, and under a former one (the API resolves old slugs).
  if (["/v1/store/products/orbe-halo-7k", "/v1/store/products/old-halo"].includes(url.pathname))
    return send(200, DETAIL);
  if (url.pathname === "/v1/store/search") {
    const q = url.searchParams.get("q") ?? "";
    const none = q.includes("zzz");
    return send(200, {
      query: q,
      approximate: q.includes("hallo"),
      sort: url.searchParams.get("sort") ?? (q ? "relevance" : "newest"),
      total: none ? 0 : 2,
      items: none ? [] : [card("Orbe Halo Grape"), card("Orbe Halo Mint", { soldOut: true })],
      nextCursor: none ? null : "c2VhcmNoLW5leHQ",
      facets: none
        ? {
            types: [],
            brands: [],
            puffCounts: [],
            nicotine: [],
            price: null,
            inStock: 0,
            onSale: 0,
          }
        : {
            types: [{ type: "disposable", count: 2 }],
            brands: [{ slug: "orbe", name: "Orbe", count: 2 }],
            puffCounts: [{ puffCount: 7000, count: 2 }],
            nicotine: [{ value: "20 mg", count: 1 }],
            price: { minFils: 4500, maxFils: 4950 },
            inStock: 1,
            onSale: 1,
          },
    });
  }
  return CATALOGUE[url.pathname]
    ? send(200, CATALOGUE[url.pathname])
    : send(404, { error: { code: "NOT_FOUND" } });
});
const stubPort = await freePort();
await new Promise((done) => stub.listen(stubPort, "127.0.0.1", done));

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn(
  process.execPath,
  [resolve(root, "scripts/next-app.cjs"), "storefront", "start"],
  {
    cwd: resolve(root, "apps/storefront"),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      APP_ENV: "staging",
      STOREFRONT_PORT: String(port),
      STOREFRONT_ORIGINS: ORIGIN,
      API_INTERNAL_URL: `http://127.0.0.1:${stubPort}`,
      AGE_POLICY_VERSION: "preview-check",
      AGE_TICKET_KEY_ID: "check",
      AGE_TICKET_PRIVATE_KEY: raw(pair.privateKey, "pkcs8"),
      AGE_TICKET_PUBLIC_KEYS: `check:${raw(pair.publicKey, "spki")}`,
    },
  },
);
let log = "";
child.stdout.on("data", (chunk) => (log += chunk));
child.stderr.on("data", (chunk) => (log += chunk));
const stop = () => {
  child.kill("SIGTERM");
  stub.close();
};
process.on("exit", stop);

const get = (path, headers = {}, method = "GET") =>
  fetch(base + path, { redirect: "manual", headers, method });
/** A refusal: redirected to the age check on our own origin, and never cacheable. */
function gated(response, name) {
  const location = response.headers.get("location") ?? "";
  const target = location ? new URL(location, ORIGIN) : null;
  check(response.status === 307, `${name}: redirected`, String(response.status));
  check(
    target?.origin === ORIGIN && target.pathname === "/age-check",
    `${name}: to the age check on our origin`,
    location,
  );
  check(response.headers.get("cache-control") === "private, no-store", `${name}: not cacheable`);
}
async function ready() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) break;
    try {
      if ((await get("/health")).status === 200) return true;
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  return false;
}
const metaOf = (html) =>
  [
    ...html.matchAll(
      /<title>[^<]*<\/title>|<meta\b[^>]*>|<link rel="(?:canonical|alternate)"[^>]*>/g,
    ),
  ]
    .map((match) => match[0])
    .sort();

try {
  if (!(await ready())) {
    console.error("Storefront did not start (run `pnpm build` first).\n" + log.slice(-600));
    process.exit(1);
  }

  // `--serve`: keep the storefront and the stub API running for a manual look in a browser.
  // Send the printed cookie as a request header (it is a throwaway ticket for this run only).
  if (process.argv.includes("--serve")) {
    const { ageTicketSigner, signAgeTicket } = createRequire(
      resolve(root, "apps/storefront/package.json"),
    )("@ih/platform/age-ticket");
    const preview = signAgeTicket(ageTicketSigner("check", raw(pair.privateKey, "pkcs8")), {
      policyVersion: "preview-check",
      ttlSeconds: 3600,
    });
    console.log(`SERVING ${base}\nCOOKIE ih_age=${preview.ticket}`);
    await new Promise((done) => process.once("SIGINT", done).once("SIGTERM", done));
    process.exit(0);
  }

  // 1. Every restricted URL, for every agent: redirect to the gate, never content.
  for (const [agent, userAgent] of Object.entries(AGENTS))
    for (const path of RESTRICTED) {
      const response = await get(path, { "user-agent": userAgent });
      const body = await response.text();
      const name = `${agent} ${path}`;
      gated(response, name);
      check(/noindex/.test(response.headers.get("x-robots-tag") ?? ""), `${name}: noindex`);
      check(!FORBIDDEN.some((pattern) => pattern.test(body)), `${name}: no catalogue data in body`);
      // A redirect body may repeat its own Location (the URL the visitor asked for); nothing else.
      check(
        !PRODUCT_TOKENS.test(body.replace(/\S*\/age-check\?return=\S*/g, "")),
        `${name}: nothing about the requested product in the body`,
      );
      // HEAD is gated exactly like GET.
      gated(await get(path, { "user-agent": userAgent }, "HEAD"), `${agent} HEAD ${path}`);
    }

  // 2. The response a preview fetcher ends on: generic, and identical for every agent.
  const gatePath = "/age-check?return=" + encodeURIComponent("/products/orbe-halo-7k-grape-ice");
  let reference;
  for (const [agent, userAgent] of Object.entries(AGENTS)) {
    const response = await get(gatePath, { "user-agent": userAgent });
    const html = await response.text();
    const meta = metaOf(html);
    check(response.status === 200, `${agent} gate page: 200`, String(response.status));
    check(html.includes('property="og:title" content="Iqos Haven"'), `${agent}: generic og:title`);
    check(html.includes('property="og:site_name" content="Iqos Haven"'), `${agent}: og:site_name`);
    check(
      html.includes('property="og:description" content="Adults-only store in Dubai. 18+."'),
      `${agent}: generic og:description`,
    );
    check(
      /property="og:image" content="https:\/\/shop\.preview-check\.test\/opengraph-image[^"]*"/.test(
        html,
      ),
      `${agent}: generic og:image`,
    );
    check(/name="robots" content="noindex, nofollow"/.test(html), `${agent}: robots meta`);
    for (const pattern of FORBIDDEN)
      check(!pattern.test(html), `${agent} gate page: no ${pattern}`);
    check(
      !meta.some((tag) => PRODUCT_TOKENS.test(tag)),
      `${agent}: requested product URL never appears in metadata`,
    );
    // The only place the requested URL may appear is the hidden return field (and its copy in
    // the page's own serialized props); it must not be rendered as content anywhere else.
    const returnFields = html.match(/<input type="hidden" name="return" value="[^"]*"\/?>/g) ?? [];
    check(
      returnFields.length === 1,
      `${agent}: exactly one return field`,
      String(returnFields.length),
    );
    const visible = html
      .replace(/<script\b[\s\S]*?<\/script>/g, "")
      .replace(/<input type="hidden" name="return" value="[^"]*"\/?>/g, "");
    check(
      !PRODUCT_TOKENS.test(visible),
      `${agent}: requested URL not rendered outside the return field`,
    );
    reference ??= meta;
    check(
      JSON.stringify(meta) === JSON.stringify(reference),
      `${agent}: same metadata as every other agent`,
    );
  }
  check(
    reference.length >= 8,
    "gate page exposes the expected metadata set",
    String(reference?.length),
  );

  // 3. No shortcut: client-controlled signals never count as verification.
  const forged = [
    { "x-age-verified": "true" },
    { "x-ih-age": "accepted", "x-ih-client-ip": "127.0.0.1" },
    { cookie: "ih_age=accepted" },
    { cookie: "ih_age=true; age_verified=1" },
    { cookie: "ih_age=v1.check.e30.AAAA" },
    { authorization: "Bearer accepted" },
    {
      "x-forwarded-for": "66.249.66.1",
      "user-agent": AGENTS.googlebot,
      from: "googlebot(at)googlebot.com",
    },
    { rsc: "1", "next-router-prefetch": "1" },
  ];
  for (const headers of forged) {
    const response = await get("/products/orbe-halo-7k-grape-ice?age=1&verified=true", headers);
    gated(response, `forged ${Object.keys(headers).join("+")}`);
  }

  // 4. Until now nobody was verified, so the storefront must not have asked the API anything.
  check(apiCalls.length === 0, "unverified requests never reach the API", String(apiCalls.length));

  // 5. A verified shopper sees the catalogue pages; only the ticket and address go to the API.
  const { ageTicketSigner, signAgeTicket } = createRequire(
    resolve(root, "apps/storefront/package.json"),
  )("@ih/platform/age-ticket");
  const { ticket } = signAgeTicket(ageTicketSigner("check", raw(pair.privateKey, "pkcs8")), {
    policyVersion: "preview-check",
    ttlSeconds: 600,
  });
  const verified = {
    cookie: `session=do-not-forward; ih_age=${ticket}; cart=private`,
    "x-ih-client-ip": "203.0.113.9",
    authorization: "Bearer do-not-forward",
  };
  const page = async (path, expected = 200) => {
    const response = await get(path, verified);
    // React separates adjacent text nodes with empty comments; they are not content.
    const html = (await response.text()).replaceAll("<!-- -->", "");
    check(response.status === expected, `verified ${path}: ${expected}`, String(response.status));
    check(
      response.headers.get("cache-control") === "private, no-store",
      `verified ${path}: not cacheable`,
      response.headers.get("cache-control") ?? "",
    );
    return html;
  };
  const shop = await page(
    "/shop?utm_source=mail&fbclid=abc&sort=price_asc&brand=orbe&evil=1&limit=9999",
  );
  for (const text of [
    "All products",
    "Orbe Halo Grape",
    "Orbe Halo Mint",
    "AED 45",
    "AED 59",
    "AED 49.50",
    "Sold out",
    "−24%",
    "New",
    "7K puffs · 4 options",
    "Next page",
  ])
    check(shop.includes(text), `shop page shows "${text}"`);
  check(
    /href="\/shop\?brand=orbe&amp;sort=price_asc&amp;cursor=bmV4dC1wYWdl"/.test(shop),
    "next-page link carries only listing state and the cursor",
  );
  check(
    ![...shop.matchAll(/(?:href|action)="([^"]*)"/g)].some((match) =>
      /utm_source|fbclid|evil=|9999/.test(match[1]),
    ),
    "tracking and unknown parameters are not carried into links or forms",
  );
  const listCall = apiCalls.find((call) => call.path === "/v1/store/products");
  check(
    listCall?.search === "?brand=orbe&sort=price_asc",
    "API receives only contract parameters",
    listCall?.search,
  );
  check(
    apiCalls.length > 0 && apiCalls.every((call) => call.headers.cookie === `ih_age=${ticket}`),
    "API receives only the age cookie",
  );
  check(
    apiCalls.every((call) => call.headers["x-ih-client-ip"] === "203.0.113.9"),
    "API receives the client address",
  );
  check(
    apiCalls.every((call) => !call.headers.authorization),
    "API receives no other credentials",
  );
  check(
    (await page("/shop?cursor=bmV4dC1wYWdl")).includes("Orbe Second Page"),
    "second page renders through the cursor",
  );
  check((await page("/disposable-vapes")).includes("Disposable Vapes"), "type page renders");
  const typeCall = apiCalls.findLast((call) => call.path === "/v1/store/products");
  check(
    typeCall?.search === "?type=disposable&sort=newest",
    "type page fixes its filter",
    typeCall?.search,
  );
  await page("/vape-kits?type=disposable");
  check(
    apiCalls.findLast((call) => call.path === "/v1/store/products")?.search ===
      "?type=kit&sort=newest",
    "a fixed filter cannot be overridden from the address bar",
  );
  const brandsPage = await page("/brands");
  check(
    brandsPage.includes("Orbe") && brandsPage.includes("2 products"),
    "brands index lists brands with products",
  );
  check(!brandsPage.includes("Empty Brand"), "brands index hides a brand with nothing to show");
  const brandPage = await page("/brands/orbe");
  check(
    brandPage.includes("Synthetic brand story.") &&
      brandPage.includes("<title>Orbe · Iqos Haven</title>"),
    "brand page shows its header and title",
  );
  await page("/brands/unknown-brand", 404);
  check((await page("/categories/disposables")).includes("Disposables"), "category page renders");
  await page("/categories/unknown-category", 404);
  for (const html of [shop, brandsPage, brandPage])
    check(
      !FORBIDDEN.some((pattern) => pattern !== FORBIDDEN[1] && pattern.test(html)),
      "no JSON-LD or price metadata even for verified pages",
    );

  // Product page: variant-specific price and stock, and nothing chosen for the shopper.
  const pdp = await page("/p/orbe-halo-7k");
  for (const text of [
    "Orbe Halo 7K",

    "Flavour",
    "Nicotine",
    "choose one",
    "grape ice",
    "50 mg",
    "Add to cart",
    "About this product",
    "Synthetic product description.",
    "Specifications",
    "Puffs (approx.)",
    "7,000",
    "E-liquid",
    "12.5 ml",
    "650 mAh",
    "Coil",
    "Cash on delivery",
    "contains nicotine",
  ])
    check(pdp.includes(text), `product page shows "${text}"`);
  check(/From <\/span>AED 45/.test(pdp), "price says From the lowest option until one is chosen");
  check(
    pdp.includes("<title>Orbe Halo 7K · Iqos Haven</title>"),
    "product page title names the product (verified only)",
  );
  check(!/<input[^>]*type="radio"[^>]*checked/.test(pdp), "no option is preselected");
  check(
    (pdp.match(/type="radio"/g) ?? []).length === 4,
    "every offered option value is a choice",
    String((pdp.match(/type="radio"/g) ?? []).length),
  );
  check(
    !/og:title" content="Orbe Halo/.test(pdp) && !FORBIDDEN[0].test(pdp),
    "product page keeps the generic preview and no JSON-LD",
  );
  const renamed = await get("/p/old-halo", verified);
  check(
    renamed.status === 308 &&
      new URL(renamed.headers.get("location") ?? "/", ORIGIN).pathname === "/p/orbe-halo-7k",
    "a former slug redirects permanently to the current one",
    `${renamed.status} ${renamed.headers.get("location")}`,
  );
  await page("/p/unknown-product", 404);
  const badSlug = apiCalls.length;
  await page("/p/Not_A_Slug", 404);
  check(apiCalls.length === badSlug, "an impossible slug is refused without an API call");

  // Cart page: the server renders only the frame; the cart itself is device state.
  const cartPage = await page("/cart");
  check(
    cartPage.includes("Your cart") && cartPage.includes("<title>Your cart · Iqos Haven</title>"),
    "cart page frame renders",
  );
  check(
    !/AED|Halo/.test(cartPage.replace(/<script[\s\S]*?<\/script>/g, "")),
    "cart page carries no catalogue data from the server",
  );

  // Search: term, filters and the similar-results notice; only contract parameters reach the API.
  const found = await page(
    "/search?q=halo&brand=orbe&brand=Bad+Slug&minPrice=30&maxPrice=60&inStock=true&utm_campaign=x&sort=price_asc",
  );
  for (const text of [
    "Results for “halo”",

    "Orbe Halo Grape",
    "Filters",
    "Nicotine strength",
    "20 mg",
    "In stock only",
    "Show results",
    "Next page",
  ])
    check(found.includes(text), `search page shows "${text}"`);
  check(/<b[^>]*>2<\/b> products/.test(found), "search page shows the total");
  const searchCall = apiCalls.findLast((call) => call.path === "/v1/store/search");
  check(
    searchCall?.search ===
      "?q=halo&brand=orbe&minPriceFils=3000&maxPriceFils=6000&inStock=true&sort=price_asc",
    "search sends only validated parameters, prices in fils",
    searchCall?.search,
  );
  check(searchCall?.headers.cookie === `ih_age=${ticket}`, "search forwards only the age cookie");
  check(
    found.includes("<title>Search · Iqos Haven</title>"),
    "the search term is not in the page title",
  );
  check(
    (await page("/search?q=hallo")).includes("Showing similar results"),
    "near-miss notice is shown",
  );
  const nothing = await page("/search?q=zzz");
  check(
    nothing.includes("No results for “zzz”") && nothing.includes("Check the spelling"),
    "no-result state is shown",
  );
  // A cursor the API refuses restarts the list instead of showing an error page.
  for (const [stale, start] of [
    ["/search?q=halo&sort=name&cursor=c3RhbGU", "/search?q=halo&sort=name"],
    ["/shop?sort=name&cursor=c3RhbGU", "/shop?sort=name"],
  ]) {
    const response = await get(stale, verified);
    const target = new URL(response.headers.get("location") ?? "/", ORIGIN);
    check(
      response.status === 307 && target.pathname + target.search === start,
      `stale cursor on ${stale.split("?")[0]} restarts at the first page`,
      `${response.status} ${response.headers.get("location")}`,
    );
  }
  const hostile = await page("/search?q=" + encodeURIComponent('"><script>alert(1)</script>'));
  check(!hostile.includes("<script>alert(1)</script>"), "search text is escaped in the page");

  // 6. What the verified shopper just loaded is still refused to the next unverified request.
  const callsBefore = apiCalls.length;
  for (const path of [
    "/shop",
    "/brands",
    "/brands/orbe",
    "/disposable-vapes",
    "/categories/disposables",
    "/search?q=halo",
    "/p/orbe-halo-7k",
  ])
    for (const headers of [
      {},
      { "user-agent": AGENTS.googlebot },
      { cookie: "ih_age=accepted" },
      { rsc: "1" },
    ]) {
      const response = await get(path, headers);
      const body = await response.text();
      gated(response, `after warm-up ${path} ${Object.keys(headers).join("+") || "plain"}`);
      check(!/Halo|Synthetic|AED|grape/.test(body), `after warm-up ${path}: no catalogue data`);
    }
  check(apiCalls.length === callsBefore, "refused requests add no API calls");

  // 7. A ticket the API no longer accepts sends the shopper back to the age check.
  apiMode = "refuse";
  const sentBack = await get("/shop", verified);
  check(
    sentBack.status === 307 &&
      new URL(sentBack.headers.get("location"), ORIGIN).pathname === "/age-check",
    "API refusal returns the shopper to the age check",
    `${sentBack.status} ${sentBack.headers.get("location")}`,
  );
  // An API outage is an error page without catalogue data or technical detail.
  apiMode = "down";
  const outage = await get("/shop", verified);
  const outageHtml = await outage.text();
  check(
    outage.status === 500,
    "API outage answers 500, not a half-rendered page",
    String(outage.status),
  );
  check(
    !/Halo|SERVICE_UNAVAILABLE|127\.0\.0\.1|stack/i.test(outageHtml),
    "outage page leaks no data or detail",
  );
  apiMode = "ok";

  // 8. Public information: crawler policy, preview image, policy pages. No sitemap while closed.
  const robots = await get("/robots.txt");
  const robotsText = await robots.text();
  check(
    robots.status === 200 && /^Disallow: \/$/m.test(robotsText),
    "robots.txt disallows everything",
  );
  check(!/sitemap/i.test(robotsText), "robots.txt advertises no sitemap");
  const image = await get("/opengraph-image");
  check(
    image.status === 200 && image.headers.get("content-type") === "image/png",
    "generic preview image is served",
    `${image.status} ${image.headers.get("content-type")}`,
  );
  for (const path of ["/responsible-use", "/terms", "/privacy"]) {
    const response = await get(path, { "user-agent": AGENTS.facebook });
    const html = await response.text();
    check(response.status === 200, `${path}: public`, String(response.status));
    check(/noindex/.test(response.headers.get("x-robots-tag") ?? ""), `${path}: noindex`);
    check(!FORBIDDEN.some((pattern) => pattern.test(html)), `${path}: no catalogue data`);
  }
} finally {
  stop();
}
if (failures) {
  console.error(`${failures} age-preview check(s) failed, ${passed} passed.`);
  process.exit(1);
}
console.log(`${passed} age-preview checks passed.`);
