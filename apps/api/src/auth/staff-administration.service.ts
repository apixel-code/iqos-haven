import {
  Inject,
  Injectable,
  ForbiddenException,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { IdentityValidationError } from "@ih/domain";
import type { CommandContext } from "@ih/application";
import {
  listStaff,
  editStaff,
  deactivateStaff,
  StaffForbiddenError,
  StaffNotFoundError,
  StaffConflictError,
  LastOwnerError,
  type Database,
} from "@ih/db";
import { DATABASE } from "../infra/tokens";
@Injectable()
export class StaffAdministrationService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  async list(actorId: string, query: { limit: number; after?: string | undefined }) {
    try {
      return await listStaff(this.db, actorId, query);
    } catch (error) {
      this.map(error);
    }
  }
  async edit(
    context: CommandContext,
    id: string,
    input: { version: number; name?: string | undefined; email?: string | undefined },
  ) {
    try {
      return await editStaff(this.db, context, id.toLowerCase(), input);
    } catch (error) {
      this.map(error);
    }
  }
  async deactivate(context: CommandContext, id: string, version: number) {
    try {
      await deactivateStaff(this.db, context, id.toLowerCase(), version);
    } catch (error) {
      this.map(error);
    }
  }
  private map(error: unknown): never {
    if (error instanceof StaffForbiddenError) throw new ForbiddenException();
    if (error instanceof StaffNotFoundError) throw new NotFoundException();
    if (error instanceof StaffConflictError || error instanceof LastOwnerError)
      throw new ConflictException();
    if (error instanceof IdentityValidationError) throw new BadRequestException();
    throw error;
  }
}
