import { ageGate } from "@/lib/age/runtime";

export const dynamic = "force-dynamic";

/** Explicit 18+ affirmation: mints the signed age ticket (the only place that can). */
export function POST(request: Request) {
  return ageGate().handlers.accept(request);
}
