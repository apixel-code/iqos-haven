import { Module } from "@nestjs/common";
import { AdminDashboardController } from "./admin-dashboard.controller";

/** Operational home dashboard (step 108). */
@Module({ controllers: [AdminDashboardController] })
export class DashboardModule {}
