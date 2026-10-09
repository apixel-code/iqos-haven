// Same-origin gateway acceptance (roadmap step 29): runs the real Caddyfile in the pinned Caddy
// image against stub upstreams and asserts routing, privacy of the API, header stripping,
// cookies, streaming and body limits. Requires Docker.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, request } from "node:http";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const IMAGE = JSON.parse(readFileSync("infra/images.lock.json", "utf8")).caddy;
const name = "ih-gateway-check-" + process.pid;

function stub(label) {
  const server = createServer((req, res) => {
    if (req.url === "/v1/admin/events/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write("data: first\n\n");
      setTimeout(() => res.end("data: second\n\n"), 1500);
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "__Host-ih_admin=opaque; Secure; HttpOnly; SameSite=Strict; Path=/",
        server: "upstream-leak",
      });
      res.end(
        JSON.stringify({
          upstream: label,
          method: req.method,
          url: req.url,
          headers: req.headers,
          bytes: body.length,
        }),
      );
    });
  });
  return new Promise((resolve) => server.listen(0, "0.0.0.0", () => resolve(server)));
}

const docker = (...args) => spawnSync("docker", args, { encoding: "utf8" });
const [store, admin, api] = await Promise.all([stub("storefront"), stub("admin"), stub("api")]);
const port = (server) => server.address().port;
const run = docker(
  "run",
  "-d",
  "--rm",
  "--name",
  name,
  "--add-host",
  "host.docker.internal:host-gateway",
  "-p",
  "127.0.0.1::8080",
  "-p",
  "127.0.0.1::8081",
  "-v",
  `${process.cwd()}/infra/gateway/Caddyfile:/etc/caddy/Caddyfile:ro`,
  "-e",
  `STOREFRONT_UPSTREAM=host.docker.internal:${port(store)}`,
  "-e",
  `ADMIN_UPSTREAM=host.docker.internal:${port(admin)}`,
  "-e",
  `API_UPSTREAM=host.docker.internal:${port(api)}`,
  `${IMAGE.image}@${IMAGE.digest}`,
);
assert.equal(run.status, 0, "gateway container failed to start: " + run.stderr);
const published = (inner) => docker("port", name, `${inner}/tcp`).stdout.trim().split(":").pop();
let checks = 0;
try {
  const storeUrl = `http://127.0.0.1:${published(8080)}`;
  const adminUrl = `http://127.0.0.1:${published(8081)}`;
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(storeUrl + "/")).ok) break;
    } catch {}
    await delay(200);
  }
  const json = async (url, init) => {
    const response = await fetch(url, init);
    return {
      status: response.status,
      headers: response.headers,
      body: response.status === 200 ? await response.json() : null,
    };
  };
  const check = (condition, message) => {
    assert.ok(condition, message);
    checks++;
  };

  // Routing: storefront origin.
  let r = await json(storeUrl + "/products/x?y=1");
  check(
    r.body?.upstream === "storefront" && r.body.url === "/products/x?y=1",
    "storefront pages go to Next",
  );
  r = await json(storeUrl + "/api/age/accept", { method: "POST", body: "{}" });
  check(
    r.body?.upstream === "storefront" && r.body.url === "/api/age/accept",
    "age endpoint served by storefront",
  );
  check(
    /^[0-9a-f-]{36}$/.test(r.headers.get("x-request-id") ?? ""),
    "request ID returned to the client",
  );
  r = await json(storeUrl + "/api/v1/store/products?page=2");
  check(
    r.body?.upstream === "api" && r.body.url === "/v1/store/products?page=2",
    "store API maps /api/v1 → /v1",
  );
  for (const path of [
    "/api/v1/admin/orders",
    "/api/v1/auth/login",
    "/api/v1/internal/revalidate",
    "/api/v1/health/ready",
  ])
    check((await fetch(storeUrl + path)).status === 404, `storefront origin hides ${path}`);

  // Routing: admin origin.
  r = await json(adminUrl + "/api/v1/auth/login", { method: "POST", body: "{}" });
  check(
    r.body?.upstream === "api" && r.body.url === "/v1/auth/login" && r.body.method === "POST",
    "admin auth → API",
  );
  r = await json(adminUrl + "/api/v1/admin/orders?status=pending");
  check(
    r.body?.upstream === "api" && r.body.url === "/v1/admin/orders?status=pending",
    "admin commands → API",
  );
  r = await json(adminUrl + "/orders");
  check(r.body?.upstream === "admin", "admin pages go to admin Next");
  for (const path of [
    "/api/v1/store/products",
    "/api/v1/internal/revalidate",
    "/api/v1/health/live",
  ])
    check((await fetch(adminUrl + path)).status === 404, `admin origin hides ${path}`);
  // Without the /api prefix nothing is ever routed to Nest.
  r = await json(adminUrl + "/v1/admin/orders");
  check(r.body?.upstream === "admin", "bare /v1 paths never reach the API");

  // Raw (un-normalized) traversal attempts cannot escape the allowlisted prefix.
  for (const raw of [
    "/api/v1/store/../internal/revalidate",
    "/api/v1/store/%2e%2e/internal/revalidate",
  ]) {
    const status = await new Promise((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: Number(published(8080)), path: raw },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () =>
            resolve(
              res.statusCode === 200 && data.includes('"url":"/v1/internal')
                ? "leaked"
                : res.statusCode,
            ),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
    check(status !== "leaked", `raw traversal ${raw} does not reach internal routes`);
  }

  // Browser-supplied trust headers never reach upstreams; gateway-owned ones replace them.
  r = await json(storeUrl + "/api/v1/store/products", {
    headers: {
      "x-age-verified": "true",
      "x-forwarded-for": "1.2.3.4",
      "x-real-ip": "1.2.3.4",
      forwarded: "for=1.2.3.4",
      "x-ih-service": "worker",
      "x-ih-signature": "forged",
      "x-ih-client-ip": "1.2.3.4",
      "x-request-id": "client-chosen-id",
      cookie: "ih_age=ticket; other=1",
    },
  });
  const h = r.body.headers;
  check(h["x-age-verified"] === undefined, "X-Age-Verified stripped");
  check(
    h["x-ih-service"] === undefined && h["x-ih-signature"] === undefined,
    "service-auth headers stripped",
  );
  check(h["x-real-ip"] === undefined && h.forwarded === undefined, "X-Real-IP/Forwarded stripped");
  check(
    !String(h["x-forwarded-for"] ?? "").includes("1.2.3.4"),
    "client X-Forwarded-For not trusted",
  );
  check(h["x-ih-client-ip"] && h["x-ih-client-ip"] !== "1.2.3.4", "gateway sets client IP itself");
  check(/^[0-9a-f-]{36}$/.test(h["x-request-id"]), "gateway assigns a request ID");
  check(h.cookie === "ih_age=ticket; other=1", "cookies forwarded intact");
  check(
    r.headers
      .get("set-cookie")
      ?.startsWith("__Host-ih_admin=opaque; Secure; HttpOnly; SameSite=Strict"),
    "Set-Cookie returned intact",
  );
  check(
    r.headers.get("server") === null && r.headers.get("via") === null,
    "no server/proxy banner",
  );

  // Hop-by-hop abuse: a client cannot use Connection to drop the gateway-set headers.
  const hop = await new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: Number(published(8080)),
        path: "/api/v1/store/products",
        headers: { connection: "keep-alive, X-IH-Client-IP, X-Request-Id" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(JSON.parse(data).headers));
      },
    );
    req.on("error", reject);
    req.end();
  });
  check(
    hop["x-ih-client-ip"] && /^[0-9a-f-]{36}$/.test(hop["x-request-id"] ?? ""),
    "Connection header cannot strip gateway headers",
  );

  // Streaming: the first SSE event arrives before the upstream finishes.
  const started = Date.now();
  const sse = await fetch(adminUrl + "/api/v1/admin/events/stream");
  const reader = sse.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  check(first.includes("first") && Date.now() - started < 1200, "SSE is streamed, not buffered");
  await reader.cancel();

  // Body limit on API routes.
  const big = await fetch(adminUrl + "/api/v1/admin/orders", {
    method: "POST",
    body: "x".repeat(70 * 1024),
  });
  check(big.status === 413, "API request bodies limited to 64KB");

  process.stdout.write(`${checks} gateway checks passed.\n`);
} finally {
  docker("rm", "-f", name);
  for (const server of [store, admin, api]) server.close();
}
