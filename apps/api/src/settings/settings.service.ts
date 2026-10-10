import {
  Inject,
  Injectable,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from "@nestjs/common";
import { settingsWriteRequestSchema, type SettingsWriteRequest } from "@ih/contracts";
import type { CommandContext } from "@ih/application";
import {
  readSettings,
  writeSetting,
  SettingsForbiddenError,
  SettingsConflictError,
  type Database,
} from "@ih/db";
import { DATABASE } from "../infra/tokens";
@Injectable()
export class SettingsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  async read(id: string) {
    try {
      return await readSettings(this.db, id);
    } catch (error) {
      this.map(error);
    }
  }
  async write(context: CommandContext, input: SettingsWriteRequest) {
    if (!settingsWriteRequestSchema.safeParse(input).success) throw new BadRequestException();
    try {
      return await writeSetting(this.db, context, input);
    } catch (error) {
      this.map(error);
    }
  }
  private map(error: unknown): never {
    if (error instanceof SettingsForbiddenError) throw new ForbiddenException();
    if (error instanceof SettingsConflictError) throw new ConflictException();
    throw error;
  }
}
