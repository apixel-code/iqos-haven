import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./age/policy";
import {
  ageRecheckHref,
  EMPTY_REVIEW,
  proofView,
  reviewRequest,
  submitOutcome,
  tokenFromHash,
  validateReview,
} from "./reviews";

const TOKEN = "a".repeat(20) + "B-_" + "9".repeat(20);
const PRODUCT = "0199e0a0-0000-7000-8000-000000000001";
const good = { rating: 5, title: "Great", body: "Works as promised.", authorName: "Sam" };
const envelope = (code: string) => ({
  error: { code, message: "x", requestId: "r", fields: [] },
});

describe("review link page", () => {
  it("takes only a well-formed token from the fragment", () => {
    expect(tokenFromHash("#" + TOKEN)).toBe(TOKEN);
    expect(tokenFromHash(TOKEN)).toBe(TOKEN);
    for (const hash of ["", "#", "#short", `#${TOKEN}x`, `#${TOKEN.slice(1)}=`, "#../../x"])
      expect(tokenFromHash(hash)).toBeNull();
  });

  it("goes back through the age question to /review with the token in the fragment only", () => {
    const href = ageRecheckHref(TOKEN);
    const url = new URL(href, "https://shop.example");
    expect(url.pathname).toBe("/age-check");
    expect(url.hash).toBe("#" + TOKEN);
    expect(url.search).not.toContain(TOKEN);
    expect(safeReturnPath(url.searchParams.get("return"))).toBe("/review");
  });

  it("reads the proof answer", () => {
    const proof = {
      expiresAt: "2026-11-14T10:00:00.000Z",
      products: [{ productId: PRODUCT, name: "Lune Air" }],
    };
    expect(proofView(200, proof)).toEqual({ kind: "open", proof });
    expect(proofView(200, { ...proof, orderNumber: "IH-1" })).toEqual({
      kind: "failed",
      limited: false,
    });
    expect(proofView(409, envelope("REVIEW_PROOF_INVALID"))).toEqual({ kind: "invalid" });
    expect(proofView(403, envelope("AGE_VERIFICATION_REQUIRED"))).toEqual({ kind: "age" });
    expect(proofView(403, envelope("FORBIDDEN"))).toEqual({ kind: "failed", limited: false });
    expect(proofView(429, null)).toEqual({ kind: "failed", limited: true });
  });

  it("checks the form as the API does, and refuses hidden characters", () => {
    expect(validateReview(good)).toEqual({});
    expect(Object.keys(validateReview(EMPTY_REVIEW)).sort()).toEqual([
      "authorName",
      "body",
      "rating",
      "title",
    ]);
    expect(validateReview({ ...good, body: "Too short" }).body).toBeDefined();
    expect(validateReview({ ...good, title: "t".repeat(121) }).title).toBeDefined();
    const sent = reviewRequest(TOKEN, PRODUCT, { ...good, title: "  Great   kit " });
    expect(sent).toEqual({
      ok: true,
      body: { token: TOKEN, productId: PRODUCT, ...good, title: "Great kit" },
    });
    // ZWNJ belongs in Persian and Arabic names; it is kept. Direction overrides are not.
    expect(reviewRequest(TOKEN, PRODUCT, { ...good, authorName: "Mehr\u200cnaz" }).ok).toBe(true);
    expect(reviewRequest(TOKEN, PRODUCT, { ...good, title: "Right\u202eto left" }).ok).toBe(false);
    expect(reviewRequest(TOKEN, PRODUCT, { ...good, title: "Zero\u200bwidth" })).toEqual({
      ok: false,
      errors: { title: "Remove unusual characters and try again." },
    });
  });

  it("reads the submission answer", () => {
    expect(submitOutcome(201, { status: "pending", remaining: 1 })).toEqual({
      kind: "sent",
      remaining: 1,
    });
    expect(submitOutcome(201, { status: "approved", remaining: 0 }).kind).toBe("failed");
    expect(submitOutcome(409, envelope("REVIEW_PROOF_INVALID"))).toEqual({ kind: "invalid" });
    expect(submitOutcome(400, envelope("VALIDATION_ERROR"))).toEqual({ kind: "rejected" });
    expect(submitOutcome(403, envelope("AGE_VERIFICATION_REQUIRED"))).toEqual({ kind: "age" });
    expect(submitOutcome(429, null)).toEqual({ kind: "failed", limited: true });
  });
});
