import { OrderConfirmationController } from "./order-confirmation.controller";
import { OrderConfirmationService } from "./order-confirmation.service";
import { Module } from "@nestjs/common";
import { StoreModule } from "../store/store.module";
import { CreateOrderService } from "./create-order.service";
import { StoreOrdersController } from "./store-orders.controller";
import { AdminOrdersController } from "./admin-orders.controller";
import { AdminOrdersService } from "./admin-orders.service";
import { OrderTransitionsController } from "./order-transitions.controller";
import { OrderCancellationController } from "./order-cancellation.controller";
import { OrderCollectionController } from "./order-collection.controller";
import { ManualOrdersController } from "./manual-orders.controller";
import { ReviewLinkController } from "./review-link.controller";

/** Order commands and the store route that places an order (step 77). */
@Module({
  imports: [StoreModule],
  controllers: [
    StoreOrdersController,
    OrderConfirmationController,
    AdminOrdersController,
    OrderTransitionsController,
    OrderCancellationController,
    OrderCollectionController,
    ManualOrdersController,
    ReviewLinkController,
  ],
  providers: [CreateOrderService, OrderConfirmationService, AdminOrdersService],
  exports: [CreateOrderService],
})
export class OrdersModule {}
