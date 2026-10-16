import { Module } from "@nestjs/common";
import { AdminAnalyticsController } from "./admin-analytics.controller";
import { AdminDashboardController } from "./admin-dashboard.controller";

/** Operational home dashboard (step 108) and the Owner's analytics (step 109). */
@Module({ controllers: [AdminDashboardController, AdminAnalyticsController] })
export class DashboardModule {}
