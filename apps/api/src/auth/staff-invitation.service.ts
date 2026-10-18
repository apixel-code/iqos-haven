import {
  Inject,
  Injectable,
  ServiceUnavailableException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ApiEnv } from "@ih/config";
import type { CommandContext } from "@ih/application";
import {
  normalizeEmail,
  normalizeStaffName,
  normalizePassword,
  passwordProblems,
  type RoleKey,
} from "@ih/domain";
import {
  issueStaffInvitation,
  revokeStaffInvitation,
  staffInvitationCandidate,
  acceptStaffInvitation,
  listPendingStaffInvitations,
  InvitationNotAllowedError,
  InvitationAccountExistsError,
  type Database,
} from "@ih/db";
import {
  Argon2PasswordHasher,
  invitationToken,
  invitationTokenHash,
  invitationTokenId,
} from "@ih/platform";
import { API_ENV, DATABASE } from "../infra/tokens";
@Injectable()
export class StaffInvitationService {
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
    const key = this.env.STAFF_INVITATION_KEYS[0];
    if (!key || !this.env.STAFF_INVITATION_ORIGIN) throw new ServiceUnavailableException();
    return key;
  }
  async issue(context: CommandContext, input: { email: string; name: string; role: RoleKey }) {
    const key = this.configured();
    const id = randomUUID();
    let email: string;
    let name: string;
    try {
      email = normalizeEmail(input.email);
      name = normalizeStaffName(input.name);
    } catch {
      throw new BadRequestException();
    }
    try {
      const row = await issueStaffInvitation(this.db, context, {
        ...input,
        email,
        name,
        id,
        tokenHash: invitationTokenHash(invitationToken(id, key)),
        keyId: key.keyId,
      });
      return { id: row.id, expiresAt: row.expiresAt.toISOString() };
    } catch (error) {
      this.mapError(error);
    }
  }
  pending() {
    return listPendingStaffInvitations(this.db);
  }
  async revoke(context: CommandContext, id: string): Promise<void> {
    try {
      await revokeStaffInvitation(this.db, context, id);
    } catch (error) {
      this.mapError(error);
    }
  }
  private mapError(error: unknown): never {
    if (error instanceof InvitationNotAllowedError) throw new ForbiddenException();
    if (error instanceof InvitationAccountExistsError) throw new ConflictException();
    throw error;
  }
  async accept(token: string, inputPassword: string, requestId: string): Promise<boolean> {
    this.configured();
    const id = invitationTokenId(token);
    if (!id) return false;
    const tokenHash = invitationTokenHash(token);
    const candidate = await staffInvitationCandidate(this.db, id, tokenHash);
    if (!candidate) return false;
    const password = normalizePassword(inputPassword);
    if (passwordProblems(password, candidate).length) return false;
    const passwordHash = await this.hasher.hash(password);
    return acceptStaffInvitation(this.db, requestId, { id, tokenHash, passwordHash });
  }
}
