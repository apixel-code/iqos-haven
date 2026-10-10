import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, authError, authRequest, consumeLinkToken, currentSession } from "./auth";
const profile = {
  user: {
    id: "a63f4905-c053-4ee5-9a43-a307f3906348",
    name: "Test Person",
    email: "test@example.test",
    role: "staff",
  },
  permissions: ["orders.read"],
};
afterEach(() => {
  vi.unstubAllGlobals();
});
describe("browser auth boundary", () => {
  it("uses the same-origin gateway, cookie credentials, no-store and strict JSON mutations", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(profile)));
    vi.stubGlobal("fetch", fetcher);
    await authRequest("login", { email: "test@example.test", password: "test-only" });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/auth/login",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@example.test", password: "test-only" }),
      }),
    );
    expect(fetcher.mock.calls[0]![1]).not.toHaveProperty("Authorization");
  });
  it("reads current permissions via a fresh validated /me response", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(profile)));
    vi.stubGlobal("fetch", fetcher);
    expect(await currentSession()).toEqual(profile);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/auth/me",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });
  it("rejects malformed /me profiles rather than trusting a successful response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ ...profile, user: { ...profile.user, role: "custom" } })),
        ),
    );
    await expect(currentSession()).rejects.toThrow();
  });
  it("keeps 401/403 failures available for session recovery and permission denial", async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("private server details", { status })),
      );
      await expect(currentSession()).rejects.toMatchObject({ status });
    }
  });
  it("handles successful empty reset, invitation and logout responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
    for (const command of ["reset", "invite/accept", "logout"] as const)
      expect(await authRequest(command, {})).toBeUndefined();
  });
  it("preserves Retry-After without exposing server errors or account existence", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("secret address", { status: 429, headers: { "Retry-After": "60" } }),
        ),
    );
    let error: unknown;
    try {
      await authRequest("forgot", { email: "test@example.test" });
    } catch (cause) {
      error = cause;
    }
    expect(authError(error, "forgot")).toContain("60 seconds");
    expect(authError(error, "forgot")).not.toContain("secret");
    expect(authError(new ApiError(401), "login")).toBe(
      "Email or password is incorrect. Try again or reset your password.",
    );
    expect(authError(new ApiError(503), "reset")).toContain("temporarily unavailable");
    expect(authError(new ApiError(403), "login")).toContain("not allowed");
  });
  it("consumes fragment tokens and immediately removes capability URLs from history", () => {
    const history = { replaceState: vi.fn() };
    expect(consumeLinkToken({ hash: "#token=test-link", pathname: "/reset" }, history)).toBe(
      "test-link",
    );
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/reset");
  });
  it("scrubs a replacement same-page capability instead of retaining its URL", () => {
    const history = { replaceState: vi.fn() };
    const location = { hash: "#token=first-link", pathname: "/reset" };
    expect(consumeLinkToken(location, history)).toBe("first-link");
    location.hash = "#token=replacement-link";
    expect(consumeLinkToken(location, history)).toBe("replacement-link");
    expect(history.replaceState).toHaveBeenCalledTimes(2);
    expect(history.replaceState).toHaveBeenLastCalledWith(null, "", "/reset");
  });
  it("refuses missing, duplicate and oversized fragment tokens and still scrubs the URL", () => {
    for (const hash of ["", "#token=", "#token=one&token=two", "#token=" + "x".repeat(201)]) {
      const history = { replaceState: vi.fn() };
      expect(consumeLinkToken({ hash, pathname: "/invite/accept" }, history)).toBeNull();
      expect(history.replaceState).toHaveBeenCalledOnce();
    }
  });
  it("propagates abort to session fetch and bounds hanging requests", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(profile)));
    vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    await currentSession(controller.signal);
    const options = fetcher.mock.calls[0]![1];
    controller.abort();
    expect(options.signal.aborted).toBe(true);
  });
});
