import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ApiEnv } from "@ih/config";
import { normalizeEmail, normalizePassword, passwordProblems } from "@ih/domain";
import {
  issuePasswordReset,
  passwordResetCandidate,
  consumePasswordReset,
  type Database,
} from "@ih/db";
import {
  Argon2PasswordHasher,
  resetToken,
  resetTokenHash,
  resetTokenId,
  resetRecipientHash,
} from "@ih/platform";
import { API_ENV, DATABASE } from "../infra/tokens";

@Injectable()
export class PasswordResetService {
  private readonly hasher;
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    @Inject(DATABASE) private readonly db: Database,
  ) {
    this.hasher = new Argon2PasswordHasher({
      memoryKib: env.ARGON2_MEMORY_KIB,
      timeCost: env.ARGON2_TIME_COST,
      parallelism: env.ARGON2_PARALLELISM,
    });
  }
  private configured() {
    const key = this.env.PASSWORD_RESET_KEYS[0];
    if (!key || !this.env.PASSWORD_RESET_ORIGIN) throw new ServiceUnavailableException();
    return key;
  }
  async request(emailInput: string, requestId: string): Promise<void> {
    const key = this.configured();
    let email: string;
    try {
      email = normalizeEmail(emailInput);
    } catch {
      return;
    }
    const id = randomUUID();
    const token = resetToken(id, key);
    await issuePasswordReset(
      this.db,
      { requestId, actorId: null },
      {
        email,
        id,
        tokenHash: resetTokenHash(token),
        keyId: key.keyId,
        recipientHash: resetRecipientHash(email, key),
      },
    );
  }
  async consume(token: string, passwordInput: string, requestId: string): Promise<boolean> {
    this.configured();
    const id = resetTokenId(token);
    if (!id) return false;
    const tokenHash = resetTokenHash(token);
    const candidate = await passwordResetCandidate(this.db, id, tokenHash);
    if (!candidate) return false;
    const password = normalizePassword(passwordInput);
    if (passwordProblems(password, candidate).length) return false;
    const passwordHash = await this.hasher.hash(password);
    return consumePasswordReset(
      this.db,
      { requestId, actorId: null },
      { id, tokenHash, userId: candidate.userId, userVersion: candidate.userVersion, passwordHash },
    );
  }
}
