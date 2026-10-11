import { Inject, Injectable } from "@nestjs/common";
import type { ApiEnv } from "@ih/config";
import {
  ageTicketKeyRing,
  readAgeCookie,
  verifyAgeTicket,
  type AgeTicketKeyRing,
  type AgeTicketResult,
} from "@ih/platform";
import { API_ENV } from "../infra/tokens";

/**
 * API side of the age gate (roadmap step 55, architecture §9, ADR 0024). The API holds public
 * verification keys only and cannot mint a ticket. With no key configured every store request is
 * refused (fail closed). The decision depends on the signed cookie alone: never on the
 * User-Agent, a header, a query parameter or an admin session.
 */
@Injectable()
export class AgeTicketVerifier {
  private readonly keys: AgeTicketKeyRing;
  private readonly policyVersion: string;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.keys = ageTicketKeyRing(env.AGE_TICKET_PUBLIC_KEYS);
    this.policyVersion = env.AGE_POLICY_VERSION;
  }

  verify(cookieHeader: string | undefined): AgeTicketResult {
    return verifyAgeTicket(readAgeCookie(cookieHeader), {
      keys: this.keys,
      audience: "api",
      policyVersion: this.policyVersion,
    });
  }
}
