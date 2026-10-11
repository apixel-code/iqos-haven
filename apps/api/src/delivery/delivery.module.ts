import { Module } from "@nestjs/common";
import { DeliveryAreasController } from "./delivery.controller";
import { DeliveryService } from "./delivery.service";
@Module({ controllers: [DeliveryAreasController], providers: [DeliveryService] })
export class DeliveryModule {}
