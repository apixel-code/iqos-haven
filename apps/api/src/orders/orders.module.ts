import { OrderConfirmationController } from "./order-confirmation.controller";
import { OrderConfirmationService } from "./order-confirmation.service";
import { Module } from "@nestjs/common";
import { StoreModule } from "../store/store.module";
import { CreateOrderService } from "./create-order.service";
import { StoreOrdersController } from "./store-orders.controller";

/** Order commands and the store route that places an order (step 77). */
@Module({
  imports: [StoreModule],
  controllers: [StoreOrdersController, OrderConfirmationController],
  providers: [CreateOrderService, OrderConfirmationService],
  exports: [CreateOrderService],
})
export class OrdersModule {}
