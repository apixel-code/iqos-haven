import { Module } from "@nestjs/common";
import { AdminReviewsController } from "./admin-reviews.controller";

/** Review moderation (step 95). Submission is a store route (`StoreReviewsController`). */
@Module({ controllers: [AdminReviewsController] })
export class ReviewsModule {}
