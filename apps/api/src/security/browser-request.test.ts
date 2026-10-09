import { describe, expect, it } from "vitest";
import { checkBrowserRequest, routeSurface } from "./browser-request";

const origins = { admin: ["https://admin.iqoshaven.com"], store: ["https://iqoshaven.com"] };
const json = { "content-type": "application/json", "content-length": "20" };
const check = (method: string, url: string, headers: Record<string, string>) =>
  checkBrowserRequest({ method, url, headers }, origins);

describe("Origin/CSRF and content-type rules", () => {
  it("classifies routes by surface", () => {
    expect(routeSurface("/v1/auth/login")).toBe("admin");
    expect(routeSurface("/v1/admin/orders?page=2")).toBe("admin");
    expect(routeSurface("/V1/STORE/checkout")).toBe("store");
    expect(routeSurface("/v1/internal/cache")).toBe("internal");
    expect(routeSurface("/v1/health/ready")).toBe("other");
    // Classified as the router sees them.
    expect(routeSurface("/v1/%61uth/login")).toBe("admin");
    expect(routeSurface("//v1//admin/x")).toBe("admin");
    expect(routeSurface("/v1/%73tore/cart#x")).toBe("store");
    expect(routeSurface("/v1/%E0%A4%A/x")).toBe("other");
  });

  it("leaves safe methods alone", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"])
      expect(check(method, "/v1/auth/me", { origin: "https://evil.example" })).toEqual({
        ok: true,
      });
  });

  it("requires the surface's own Origin on every state-changing request", () => {
    const admin = "https://admin.iqoshaven.com";
    expect(check("POST", "/v1/auth/login", { ...json, origin: admin })).toEqual({ ok: true });
    expect(check("POST", "/v1/auth/logout", {})).toMatchObject({
      status: 403,
      reason: "origin_missing",
    });
    for (const origin of ["https://evil.example", "null", "https://iqoshaven.com", admin + ":443"])
      expect(check("DELETE", "/v1/admin/x", { origin })).toMatchObject({
        status: 403,
        reason: "origin_not_allowed",
      });
    expect(check("POST", "/v1/store/checkout", { ...json, origin: admin })).toMatchObject({
      status: 403,
    });
    expect(check("PATCH", "/v1/store/cart", { ...json, origin: "https://iqoshaven.com" })).toEqual({
      ok: true,
    });
  });

  it("fails closed for encoded admin paths and unknown surfaces", () => {
    const store = "https://iqoshaven.com";
    expect(check("POST", "/v1/%61uth/login", { ...json, origin: store })).toMatchObject({
      status: 403,
      reason: "origin_not_allowed",
    });
    for (const url of ["/v1/health/ready", "/v1/other", "/v1/%E0%A4%A/x"])
      expect(check("POST", url, { ...json, origin: "https://admin.iqoshaven.com" })).toMatchObject({
        status: 403,
        reason: "unknown_surface",
      });
  });

  it("refuses requests the browser marks as cross-site or same-site", () => {
    const origin = "https://admin.iqoshaven.com";
    for (const site of ["cross-site", "same-site"])
      expect(
        check("POST", "/v1/auth/login", { ...json, origin, "sec-fetch-site": site }),
      ).toMatchObject({ status: 403, reason: "cross_site" });
    expect(
      check("POST", "/v1/auth/login", { ...json, origin, "sec-fetch-site": "same-origin" }),
    ).toEqual({ ok: true });
  });

  it("accepts only JSON bodies, including on internal routes", () => {
    const origin = "https://admin.iqoshaven.com";
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "",
    ])
      expect(
        check("POST", "/v1/auth/login", { origin, "content-type": type, "content-length": "5" }),
      ).toMatchObject({ status: 415 });
    expect(
      check("POST", "/v1/auth/login", {
        origin,
        "content-type": "Application/JSON; charset=utf-8",
        "transfer-encoding": "chunked",
      }),
    ).toEqual({ ok: true });
    // No body, no content type needed (logout).
    expect(check("POST", "/v1/auth/logout", { origin })).toEqual({ ok: true });
    // Internal: no Origin (HMAC instead), but still JSON only.
    expect(check("POST", "/v1/internal/x", json)).toEqual({ ok: true });
    expect(
      check("POST", "/v1/internal/x", { "content-type": "text/plain", "content-length": "3" }),
    ).toMatchObject({ status: 415 });
  });
});
