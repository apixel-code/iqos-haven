import { OrderConfirmationController } from "./order-confirmation.controller";
import { OrderConfirmationService } from "./order-confirmation.service";
import { Module } from "@nestjs/common";
import { StoreModule } from "../store/store.module";
import { CreateOrderService } from "./create-order.service";
import { StoreOrdersController } from "./store-orders.controller";
import { AdminOrdersController } from "./admin-orders.controller";
import { AdminOrdersService } from "./admin-orders.service";

/** Order commands and the store route that places an order (step 77). */
@Module({
  imports: [StoreModule],
  controllers: [StoreOrdersController, OrderConfirmationController, AdminOrdersController],
  providers: [CreateOrderService, OrderConfirmationService, AdminOrdersService],
  exports: [CreateOrderService],
})
export class OrdersModule {}
