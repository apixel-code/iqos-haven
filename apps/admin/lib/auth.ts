import { meResponseSchema, type MeResponse } from "@ih/contracts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: number | null = null,
  ) {
    super("Request could not be completed");
  }
}
/** Same-origin only: the browser owns the HttpOnly cookie; tokens never enter app storage. */
export async function authRequest(
  command: "login" | "logout" | "forgot" | "reset" | "invite/accept" | "me",
  body?: unknown,
  signal?: AbortSignal,
) {
  const response = await fetch(`/api/v1/auth/${command}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const seconds = Number(response.headers.get("Retry-After"));
    throw new ApiError(response.status, Number.isFinite(seconds) && seconds > 0 ? seconds : null);
  }
  if (response.status === 204) return undefined;
  return response.json() as Promise<unknown>;
}
export async function currentSession(signal?: AbortSignal): Promise<MeResponse> {
  return meResponseSchema.parse(await authRequest("me", undefined, signal));
}
export function authError(error: unknown, mode: string): string {
  if (!(error instanceof ApiError)) return "Could not connect. Please try again.";
  if (error.status === 429)
    return error.retryAfter
      ? `Too many attempts. Try again in ${error.retryAfter} seconds.`
      : "Too many attempts. Please try again later.";
  if (error.status === 503)
    return "This service is temporarily unavailable. Please try again later.";
  if (error.status === 403)
    return "This request is not allowed. Open the admin site and try again.";
  if (mode === "login" && error.status === 401)
    return "Email or password is incorrect. Try again or reset your password.";
  if (error.status === 400)
    return "The link or details could not be accepted. Check the password rules or request a new link.";
  return "Could not complete this request. Please try again.";
}
/** Only a fragment is a supported email capability; remove it before any request or navigation. */
export function consumeLinkToken(
  location: { hash: string; pathname: string },
  history: { replaceState: (data: unknown, unused: string, url: string) => void },
): string | null {
  const values = new URLSearchParams(location.hash.slice(1)).getAll("token");
  history.replaceState(null, "", location.pathname);
  return values.length === 1 && values[0] && values[0].length <= 200 ? values[0] : null;
}
