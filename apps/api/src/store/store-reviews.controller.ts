import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import {
  storeReviewProofRequestSchema,
  storeReviewProofResponseSchema,
  storeReviewRequestSchema,
  storeReviewResponseSchema,
  type StoreReviewRequest,
} from "@ih/contracts";
import { readReviewProof, ReviewProofInvalidError, submitReview, type Database } from "@ih/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { isIP } from "node:net";
import { AgeVerified } from "../auth/access";
import { Serialize } from "../auth/serialize";
import { requestId } from "../http/request-id";
import { createZodDto } from "../http/zod-validation.pipe";
import { DATABASE } from "../infra/tokens";
import { STORE_REVIEW_PROOF_POLICY, STORE_REVIEW_SUBMIT_POLICY } from "../security/limit-policies";
import { RateLimitService } from "../security/rate-limit.service";

class ProofDto extends createZodDto(storeReviewProofRequestSchema) {
  declare token: string;
}
class ReviewDto extends createZodDto(storeReviewRequestSchema) {
  declare token: string;
  declare productId: string;
  declare rating: number;
  declare title: string;
  declare body: string;
  declare authorName: string;
}
/** One answer for every link that proves nothing, so nothing about it can be probed. */
const invalid = () => new ConflictException({ code: "REVIEW_PROOF_INVALID" });

/**
 * Review submission through a staff-sent link (roadmap step 94, ADR 0061/0062). Behind the age
 * ticket and the store Origin check, limited per address, never cached. The token comes in the
 * body only (the logger redacts it). A link shows product names and nothing about the order;
 * every review starts pending and is published only by moderation (step 95).
 */
@Controller({ path: "store/reviews", version: "1" })
export class StoreReviewsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly limits: RateLimitService,
  ) {}

  private async guard(
    policy: typeof STORE_REVIEW_PROOF_POLICY,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    reply
      .header("Cache-Control", "private, no-store")
      .header("Vary", "Cookie")
      .header("Referrer-Policy", "no-referrer");
    const header = request.headers["x-ih-client-ip"];
    const ip = typeof header === "string" && isIP(header) ? header : request.ip;
    await this.limits.enforce(policy, { ip }, request, reply);
  }

  /** What the link may be used for: the products left to review. */
  @Post("proof")
  @HttpCode(200)
  @AgeVerified()
  @Serialize(storeReviewProofResponseSchema)
  async proof(
    @Body() body: ProofDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.guard(STORE_REVIEW_PROOF_POLICY, request, reply);
    const proof = await readReviewProof(this.db, body.token);
    if (!proof) throw invalid();
    return proof;
  }

  @Post()
  @HttpCode(201)
  @AgeVerified()
  @Serialize(storeReviewResponseSchema)
  async submit(
    @Body() body: ReviewDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.guard(STORE_REVIEW_SUBMIT_POLICY, request, reply);
    try {
      return await submitReview(this.db, {
        ...(body as StoreReviewRequest),
        requestId: requestId(request.raw as typeof request.raw & { id?: string }),
      });
    } catch (error) {
      if (error instanceof ReviewProofInvalidError) throw invalid();
      throw error;
    }
  }
}
