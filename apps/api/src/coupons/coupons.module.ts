import { Module } from "@nestjs/common";
import { AdminCouponsController } from "./coupons.controller";
import { CouponsService } from "./coupons.service";
@Module({ controllers: [AdminCouponsController], providers: [CouponsService] })
export class CouponsModule {}
