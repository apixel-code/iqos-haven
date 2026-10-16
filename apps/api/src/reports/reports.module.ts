import { Module } from "@nestjs/common";
import { AdminReportsController } from "./admin-reports.controller";

/** Report requests and status (step 110); generators and downloads in steps 111–112. */
@Module({ controllers: [AdminReportsController] })
export class ReportsModule {}
