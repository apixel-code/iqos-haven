// Age-boundary preview check (roadmap step 57, ADR 0026). Starts the BUILT storefront on a free
// port with a throwaway key pair and proves, over real HTTP, that a request without a valid age
// ticket gets only the generic store preview: no product name, image, price or JSON-LD, the same
// metadata for every User-Agent, and no header/cookie/query shortcut. Needs `pnpm build` first;
// no Docker or database. Extend RESTRICTED with real product URLs when catalogue pages exist.
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://shop.preview-check.test";
const RESTRICTED = [
  "/",
  "/shop?brand=orbe",
  "/products/orbe-halo-7k-grape-ice",
  "/brands/orbe",
  "/cart",
  "/checkout",
  "/sitemap.xml",
  "/_next/image",
  "/_next/image?url=%2Fmedia%2Fhalo.webp&w=640&q=75",
  "/_next/image?url=https%3A%2F%2Fmedia.example%2Forbe-halo.webp&w=640&q=75",
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
      API_INTERNAL_URL: "http://127.0.0.1:9",
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
const stop = () => child.kill("SIGTERM");
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

  // 4. Public information: crawler policy, preview image, policy pages. No sitemap while closed.
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
