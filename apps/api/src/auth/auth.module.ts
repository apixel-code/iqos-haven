import { Global, Module } from "@nestjs/common";
import { APP_GUARD, DiscoveryModule } from "@nestjs/core";
import { AccessGuard, AccessPolicyCheck } from "./access";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SerializeInterceptor } from "./serialize";

/** Sign-in/sessions plus the global deny-by-default access guard for every route. */
@Global()
@Module({
  imports: [DiscoveryModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    SerializeInterceptor,
    AccessPolicyCheck,
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [AuthService, SerializeInterceptor],
})
export class AuthModule {}
