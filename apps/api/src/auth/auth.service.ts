import { Inject, Injectable, type OnModuleInit } from "@nestjs/common";
import type { ApiEnv } from "@ih/config";
import type { MeResponse } from "@ih/contracts";
import {
  authenticateSession,
  createSession,
  findLoginCandidate,
  revokeSessionByTokenHash,
  upgradePasswordHash,
  type AuthenticatedStaff,
  type Database,
} from "@ih/db";
import {
  clientLabel,
  ipNetwork,
  normalizeEmail,
  normalizePassword,
  PASSWORD_MAX_LENGTH,
} from "@ih/domain";
import { Argon2PasswordHasher, argon2ParamsFromEnv } from "@ih/platform";
import { API_ENV, DATABASE } from "../infra/tokens";
import { hashSessionToken, newSessionToken } from "./session-cookie";

export class InvalidCredentialsError extends Error {
  readonly code = "INVALID_CREDENTIALS";
}

export interface LoginResult {
  readonly token: string;
  readonly staff: AuthenticatedStaff;
}

/**
 * Login/session use cases. Every failure is the same generic error; unknown accounts still pay
 * for one argon2 verification so response time does not reveal whether an email exists.
 */
@Injectable()
export class AuthService implements OnModuleInit {
  private readonly hasher: Argon2PasswordHasher;
  private dummyHash: Promise<string> | undefined;

  constructor(
    @Inject(API_ENV) env: ApiEnv,
    @Inject(DATABASE) private readonly db: Database,
  ) {
    this.hasher = new Argon2PasswordHasher(argon2ParamsFromEnv(env));
  }

  /** Prepare the dummy hash at startup so the first unknown-account login is not slower. */
  async onModuleInit(): Promise<void> {
    await this.dummy();
  }

  private dummy(): Promise<string> {
    // A real hash with current parameters, of a random throwaway value.
    this.dummyHash ??= this.hasher.hash(newSessionToken());
    return this.dummyHash;
  }

  async login(
    input: { email: string; password: string },
    client: { ip?: string | undefined; userAgent?: string | undefined },
  ): Promise<LoginResult> {
    let email: string | null;
    try {
      email = normalizeEmail(input.email);
    } catch {
      email = null;
    }
    const password = normalizePassword(input.password);
    const candidate = email ? await findLoginCandidate(this.db, email) : null;
    // Every failure path costs exactly one argon2 verification (dummy hash/placeholder input
    // where needed), so timing reveals neither whether the account exists nor the length check.
    const tooLong = [...password].length > PASSWORD_MAX_LENGTH;
    const verified = await this.hasher.verify(
      candidate?.passwordHash ?? (await this.dummy()),
      tooLong ? "over-length-placeholder" : password,
    );
    if (!candidate || !candidate.active || !verified || tooLong)
      throw new InvalidCredentialsError("Invalid credentials");

    let currentHash = candidate.passwordHash;
    if (this.hasher.needsRehash(currentHash)) {
      const upgraded = await this.hasher.hash(password);
      if (await upgradePasswordHash(this.db, candidate.id, currentHash, upgraded))
        currentHash = upgraded;
    }

    const token = newSessionToken();
    // Inserted only if the user is still active with the hash we verified: a concurrent password
    // reset or deactivation wins over this login.
    const session = await createSession(this.db, {
      userId: candidate.id,
      expectedPasswordHash: currentHash,
      tokenHash: hashSessionToken(token),
      ipNetwork: ipNetwork(client.ip),
      clientLabel: clientLabel(client.userAgent),
    });
    if (!session) throw new InvalidCredentialsError("Invalid credentials");
    const staff = await authenticateSession(this.db, hashSessionToken(token));
    if (!staff) throw new InvalidCredentialsError("Invalid credentials");
    return { token, staff };
  }

  authenticate(token: string): Promise<AuthenticatedStaff | null> {
    return authenticateSession(this.db, hashSessionToken(token));
  }

  logout(token: string): Promise<void> {
    return revokeSessionByTokenHash(this.db, hashSessionToken(token));
  }
}

export function toMeResponse(staff: AuthenticatedStaff): MeResponse {
  return {
    user: { id: staff.userId, email: staff.email, name: staff.name, role: staff.role },
    permissions: [...staff.permissions],
  };
}
