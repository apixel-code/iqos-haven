import { randomUUID } from "node:crypto";
const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
export function requestId(req: { id?: unknown; headers: Record<string, unknown> }): string {
  if (typeof req.id === "string" && SAFE_REQUEST_ID.test(req.id)) return req.id;
  const inbound = req.headers["x-request-id"];
  const id = typeof inbound === "string" && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
  req.id = id;
  return id;
}
