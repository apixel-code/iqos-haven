import { ageGate } from "@/lib/age/runtime";

export const dynamic = "force-dynamic";

/** Under-age answer: clears any acceptance and marks the device restricted for a short time. */
export function POST(request: Request) {
  return ageGate().handlers.reject(request);
}
