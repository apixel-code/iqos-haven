import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { CommandContext } from "@ih/application";
import type { GuideCreateRequest, GuideUpdateRequest } from "@ih/contracts";
import {
  createGuide,
  GuideConflictError,
  GuideForbiddenError,
  GuideNotFoundError,
  listGuides,
  listStoreGuides,
  readGuide,
  readStoreGuide,
  updateGuide,
  type Database,
} from "@ih/db";
import { DATABASE } from "../infra/tokens";

/** Guides (ADR 0117): the Owner's admin commands and the store's reads. */
@Injectable()
export class GuidesService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}
  private async execute<T>(work: () => Promise<T>) {
    try {
      return await work();
    } catch (error) {
      if (error instanceof GuideForbiddenError) throw new ForbiddenException();
      if (error instanceof GuideConflictError) throw new ConflictException({ code: error.reason });
      if (error instanceof GuideNotFoundError) throw new NotFoundException();
      throw error;
    }
  }
  list(actor: string) {
    return this.execute(() => listGuides(this.db, actor));
  }
  read(actor: string, id: string) {
    return this.execute(() => readGuide(this.db, actor, id));
  }
  create(context: CommandContext, input: GuideCreateRequest) {
    return this.execute(() => createGuide(this.db, context, input));
  }
  update(context: CommandContext, id: string, input: GuideUpdateRequest) {
    return this.execute(() => updateGuide(this.db, context, id, input));
  }
  async storeList() {
    return { items: await listStoreGuides(this.db) };
  }
  async storeRead(slug: string) {
    const guide = await readStoreGuide(this.db, slug);
    if (!guide) throw new NotFoundException();
    return guide;
  }
}
