import { Controller, Get, HttpCode, Inject, Res } from "@nestjs/common";
import { publicBusinessSchema } from "@ih/contracts";
import { readPublicBusiness, type Database } from "@ih/db";
import type { FastifyReply } from "fastify";
import { Public } from "../auth/access";
import { DATABASE } from "../infra/tokens";

/**
 * `GET /v1/public/business` (ADR 0106): the legal name and trade licence number for the shop
 * footer and the policy pages, which are served without an age ticket. Business facts only, no
 * catalogue data. Kept briefly in shared caches: a change shows within a minute.
 */
@Controller({ path: "public/business", version: "1" })
export class PublicBusinessController {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  @Get()
  @Public()
  @HttpCode(200)
  async read(@Res({ passthrough: true }) reply: FastifyReply) {
    reply.header("Cache-Control", "public, max-age=60");
    return publicBusinessSchema.parse(await readPublicBusiness(this.db));
  }
}
