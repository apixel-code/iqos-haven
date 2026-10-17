import {
  errorEnvelopeSchema,
  REVIEW_AUTHOR_MAX,
  REVIEW_BODY_MAX,
  REVIEW_BODY_MIN,
  REVIEW_TITLE_MAX,
  reviewProofTokenSchema,
  storeReviewProofResponseSchema,
  storeReviewRequestSchema,
  storeReviewResponseSchema,
  type StoreReviewProofResponse,
} from "@ih/contracts";
import { AGE_CHECK_PATH } from "@/lib/age/policy";

/**
 * The review page (roadmap step 94, ADR 0062). Staff send a link `/review#<token>`. The token
 * is read from the fragment once, kept in page memory only, and sent to the API in request
 * bodies; it never goes into a query string, device storage or a Referer.
 */
export function tokenFromHash(hash: string): string | null {
  const token = hash.startsWith("#") ? hash.slice(1) : hash;
  return reviewProofTokenSchema.safeParse(token).success ? token : null;
}

/**
 * Back through the age question without losing the link: the question page carries the
 * fragment onto its accept form, and the redirect after accepting keeps it.
 */
export const ageRecheckHref = (token: string) =>
  `${AGE_CHECK_PATH}?recheck=1&return=${encodeURIComponent("/review")}#${token}`;

const codeOf = (body: unknown) => {
  const parsed = errorEnvelopeSchema.safeParse(body);
  return parsed.success ? parsed.data.error.code : null;
};

export type ProofView =
  | { kind: "open"; proof: StoreReviewProofResponse }
  /** Unknown, replaced, expired, or nothing left to review: one answer, by design. */
  | { kind: "invalid" }
  | { kind: "age" }
  | { kind: "failed"; limited: boolean };
export function proofView(status: number, body: unknown): ProofView {
  if (status === 200) {
    const proof = storeReviewProofResponseSchema.safeParse(body);
    return proof.success ? { kind: "open", proof: proof.data } : { kind: "failed", limited: false };
  }
  if (status === 409 || status === 400) return { kind: "invalid" };
  if (status === 403 && codeOf(body) === "AGE_VERIFICATION_REQUIRED") return { kind: "age" };
  return { kind: "failed", limited: status === 429 };
}

export interface ReviewForm {
  rating: number;
  title: string;
  body: string;
  authorName: string;
}
export const EMPTY_REVIEW: ReviewForm = { rating: 0, title: "", body: "", authorName: "" };
export type ReviewField = keyof ReviewForm;
export type ReviewErrors = Partial<Record<ReviewField, string>>;

/** The same rules the API applies, worded for the form. The API decides in the end. */
export function validateReview(form: ReviewForm): ReviewErrors {
  const errors: ReviewErrors = {};
  if (!(form.rating >= 1 && form.rating <= 5)) errors.rating = "Choose from 1 to 5 stars.";
  const title = form.title.trim();
  if (!title) errors.title = "Add a short title.";
  else if (title.length > REVIEW_TITLE_MAX)
    errors.title = `Keep the title under ${REVIEW_TITLE_MAX} characters.`;
  const body = form.body.trim();
  if (body.length < REVIEW_BODY_MIN) errors.body = `Write at least ${REVIEW_BODY_MIN} characters.`;
  else if (body.length > REVIEW_BODY_MAX)
    errors.body = `Keep your review under ${REVIEW_BODY_MAX} characters.`;
  const name = form.authorName.trim();
  if (!name) errors.authorName = "Add the name to show with your review.";
  else if (name.length > REVIEW_AUTHOR_MAX)
    errors.authorName = `Keep the name under ${REVIEW_AUTHOR_MAX} characters.`;
  return errors;
}

/** The request body, or field errors when the contract would refuse it (control characters…). */
export function reviewRequest(
  token: string,
  productId: string,
  form: ReviewForm,
): { ok: true; body: unknown } | { ok: false; errors: ReviewErrors } {
  const errors = validateReview(form);
  if (Object.keys(errors).length) return { ok: false, errors };
  const parsed = storeReviewRequestSchema.safeParse({ token, productId, ...form });
  if (parsed.success) return { ok: true, body: parsed.data };
  const fields: ReviewErrors = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === "title" || field === "body" || field === "authorName" || field === "rating")
      fields[field] ??= "Remove unusual characters and try again.";
  }
  return {
    ok: false,
    errors: Object.keys(fields).length ? fields : { body: "Check your review." },
  };
}

export type SubmitOutcome =
  | { kind: "sent"; remaining: number }
  | { kind: "invalid" }
  | { kind: "age" }
  | { kind: "rejected" }
  | { kind: "failed"; limited: boolean };
export function submitOutcome(status: number, body: unknown): SubmitOutcome {
  if (status === 201) {
    const sent = storeReviewResponseSchema.safeParse(body);
    return sent.success
      ? { kind: "sent", remaining: sent.data.remaining }
      : { kind: "failed", limited: false };
  }
  if (status === 409) return { kind: "invalid" };
  if (status === 400) return { kind: "rejected" };
  if (status === 403 && codeOf(body) === "AGE_VERIFICATION_REQUIRED") return { kind: "age" };
  return { kind: "failed", limited: status === 429 };
}
