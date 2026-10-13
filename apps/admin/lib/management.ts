import {
  settingsWriteRequestSchema,
  deliveryConfigurationWriteRequestSchema,
  type SettingsWriteRequest,
} from "@ih/contracts";
import { ApiError } from "./auth";
export type ResponseContract<T> = { parse: (input: unknown) => T };
export const emptyResponse: ResponseContract<undefined> = {
  parse(value) {
    if (value !== undefined) throw new Error("Unexpected response");
    return undefined;
  },
};
/** Only same-origin admin paths; never store credentials or trust caller-supplied permissions. */
export async function managementRequest<T>(
  path: string,
  schema: ResponseContract<T>,
  method: "GET" | "POST" | "PATCH" | "PUT" = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  if (
    !/^\/(settings|staff|delivery-areas|coupons|brands|categories|products|inventory|media|orders)(?:[/?]|$)/.test(
      path,
    ) ||
    path.includes("..") ||
    path.includes("#")
  )
    throw new Error("Invalid admin path");
  const response = await fetch(`/api/v1/admin${path}`, {
    method,
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
    let code: string | null = null;
    try {
      const envelope = (await response.json()) as { error?: { code?: unknown } };
      if (typeof envelope.error?.code === "string") code = envelope.error.code.slice(0, 64);
    } catch {
      code = null;
    }
    throw new ApiError(
      response.status,
      Number.isFinite(seconds) && seconds > 0 ? seconds : null,
      code,
    );
  }
  return schema.parse(response.status === 204 ? undefined : await response.json());
}
export class FormValidationError extends Error {}
export function validate<T>(
  schema: {
    safeParse: (value: unknown) => {
      success: boolean;
      data?: T;
      error?: { issues: Array<{ path: PropertyKey[] }> };
    };
  },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const fields = [...new Set(result.error?.issues.map((issue) => issue.path.join(".")))].filter(
      Boolean,
    );
    throw new FormValidationError(
      `Check the required fields, formats and limits${fields.length ? ": " + fields.join(", ") : "."}`,
    );
  }
  return result.data!;
}
const text = (data: FormData, field: string) => String(data.get(field) ?? "").trim();
const optional = (data: FormData, field: string) => text(data, field) || null;
const checked = (data: FormData, field: string) => data.get(field) === "on";
export function settingsCommand(
  key: SettingsWriteRequest["key"],
  version: number,
  data: FormData,
): SettingsWriteRequest {
  let value: unknown;
  if (key === "store")
    value = {
      name: text(data, "name"),
      domain: text(data, "domain"),
      legalName: optional(data, "legalName"),
    };
  if (key === "contact")
    value = {
      email: optional(data, "email"),
      phone: optional(data, "phone"),
      address: optional(data, "address"),
      openingHours: optional(data, "openingHours"),
      footerNote: optional(data, "footerNote"),
      social: Object.fromEntries(
        ["instagram", "tiktok", "facebook"].map((k) => [k, optional(data, "social." + k)]),
      ),
    };
  if (key === "notifications")
    value = {
      inApp: checked(data, "inApp"),
      newOrderEmail: {
        enabled: checked(data, "newOrderEmail.enabled"),
        recipients: text(data, "recipients")
          .split(/[\n,]/)
          .map((email) => email.trim())
          .filter(Boolean),
      },
    };
  if (key === "whatsapp")
    value = {
      number: optional(data, "number"),
      templates: Object.fromEntries(
        ["orderConfirmation", "statusUpdate", "support"].map((k) => [
          k,
          optional(data, "templates." + k),
        ]),
      ),
    };
  return validate(settingsWriteRequestSchema, { key, version, value });
}
/** Decimal text to integer fils. Never multiply a floating-point AED amount. */
export function aedToFils(value: string): number {
  if (!/^\d{1,8}(?:\.\d{1,2})?$/.test(value.trim()))
    throw new FormValidationError("Enter an AED amount with at most two decimal places.");
  const [whole, fraction = ""] = value.trim().split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  if (amount > 1_000_000_000) throw new FormValidationError("Amount exceeds the allowed limit.");
  return amount;
}
export function filsToAed(value: number) {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}
export function deliveryCommand(version: number, data: FormData) {
  return validate(deliveryConfigurationWriteRequestSchema, {
    version,
    value: {
      flatFeeFils: aedToFils(text(data, "fee")),
      etaText: text(data, "etaText"),
      freeThresholdFils: null,
    },
  });
}
export function managementError(error: unknown, mutation = false) {
  if (error instanceof FormValidationError) return error.message;
  if (error instanceof ApiError) {
    if (error.status === 409 && error.code === "IN_USE")
      return "Other records still depend on this (published products or stock history), so it is kept.";
    if (error.status === 409 && error.code === "DUPLICATE")
      return "That name or link is already used (including in Trash). Choose another.";
    if (error.status === 409 && error.code === "IMAGE_LIMIT")
      return "This product already has eight images or uploads in progress. Remove one first.";
    if (error.status === 409 && error.code === "MEDIA_NOT_READY")
      return "This image is not processed yet. Wait for it to be ready.";
    if (error.status === 409 && error.code === "ORDER_MISMATCH")
      return "The gallery changed meanwhile. Reload and arrange again.";
    if (error.status === 409 && error.code === "UPLOAD_EXPIRED")
      return "The upload took too long. Choose the file again.";
    if (error.status === 409 && error.code === "UPLOAD_MISSING")
      return "The file did not arrive. Choose the file again.";
    if (error.status === 409 && error.code === "VERSION_CONFLICT")
      return "Someone changed this meanwhile. Reload current values and try again.";
    if (error.status === 409 && error.code === "LIMIT_BELOW_USES")
      return "Orders already hold more uses than that limit. Choose a limit at or above the uses shown.";
    if (error.status === 409 && error.code === "ALREADY_EXPIRED")
      return "The end time has already passed. Choose a later end, or save the coupon as inactive.";
    if (error.status === 409 && error.code === "TRASHED")
      return "This record is in Trash. Restore it before making changes.";
    if (error.status === 409)
      return "This change conflicts with current data or account rules. Reload current values before trying again.";
    if (error.status === 403) return "You no longer have access to this action.";
    if (error.status === 400) return "Check the required fields, formats and limits.";
    if (error.status === 404) return "This record is no longer available. Reload the list.";
    if (error.status === 429)
      return error.retryAfter
        ? `Too many changes. Try again in ${error.retryAfter} seconds.`
        : "Too many changes. Try again later.";
    if (error.status === 503)
      return "This service is temporarily unavailable. Reload before retrying.";
  }
  return mutation
    ? "Could not confirm whether the change was saved. Reload current values before retrying."
    : "Could not load current values. Reconnect and try again.";
}
