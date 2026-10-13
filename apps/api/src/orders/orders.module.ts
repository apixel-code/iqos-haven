import { Module } from "@nestjs/common";
import { StoreModule } from "../store/store.module";
import { CreateOrderService } from "./create-order.service";

/** Order commands. The store route that reaches them arrives in step 77. */
@Module({ imports: [StoreModule], providers: [CreateOrderService], exports: [CreateOrderService] })
export class OrdersModule {}
