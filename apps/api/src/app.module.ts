import { Module, type DynamicModule, type Type } from "@nestjs/common";
import type { ApiEnv } from "@ih/config";
import { loggerOptions } from "@ih/logger";
import { LoggerModule } from "nestjs-pino";
import { ReliabilityModule } from "./reliability/reliability.module";
import { HealthModule } from "./health/health.module";
import { InfraModule, type InfraOverrides } from "./infra/infra.module";
import { AuthModule } from "./auth/auth.module";
import { SecurityModule } from "./security/security.module";
import { InternalModule } from "./internal/internal.module";
import { DeliveryModule } from "./delivery/delivery.module";
import { CouponsModule } from "./coupons/coupons.module";
import { OrdersModule } from "./orders/orders.module";
import { CustomersModule } from "./customers/customers.module";
import { CatalogueCacheModule } from "./cache/catalogue-cache.module";
import { CatalogueModule } from "./catalogue/catalogue.module";
import { InventoryModule } from "./inventory/inventory.module";
import { MediaModule } from "./media/media.module";
import { StoreModule } from "./store/store.module";
import { SettingsModule } from "./settings/settings.module";
import { requestId } from "./http/request-id";
@Module({})
export class AppModule {
  /** `testModules`: test seam for probe controllers in integration tests; production passes none. */
  static register(
    env: ApiEnv,
    overrides?: InfraOverrides,
    testModules: readonly Type[] = [],
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        LoggerModule.forRoot({
          pinoHttp: {
            ...loggerOptions("api", env.LOG_LEVEL),
            genReqId: (req, res) => {
              const id = requestId(req);
              res.setHeader("x-request-id", id);
              return id;
            },
            serializers: {
              req: (req: { id: string; method: string }) => ({ id: req.id, method: req.method }),
            },
            autoLogging: {
              ignore: (req) => /^\/v1\/health\/(live|ready)(?:\?|$)/.test(req.url ?? ""),
            },
          },
        }),
        InfraModule.register(env, overrides),
        InternalModule,
        CatalogueCacheModule,
        SecurityModule,
        AuthModule,
        SettingsModule,
        DeliveryModule,
        CouponsModule,
        OrdersModule,
        CustomersModule,
        CatalogueModule,
        InventoryModule,
        MediaModule,
        StoreModule,
        ReliabilityModule,
        HealthModule,
        ...testModules,
      ],
    };
  }
}
