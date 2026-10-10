import { Global, Module } from "@nestjs/common";
import { APP_GUARD, DiscoveryModule } from "@nestjs/core";
import { StaffController } from "./staff-administration.controller";
import { StaffAdministrationService } from "./staff-administration.service";
import { AccessGuard, AccessPolicyCheck } from "./access";
import {
  StaffInvitationController,
  StaffInvitationAcceptController,
} from "./staff-invitation.controller";
import { StaffInvitationService } from "./staff-invitation.service";
import { PasswordResetController } from "./password-reset.controller";
import { PasswordResetService } from "./password-reset.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SerializeInterceptor } from "./serialize";

/** Sign-in/sessions plus the global deny-by-default access guard for every route. */
@Global()
@Module({
  imports: [DiscoveryModule],
  controllers: [
    AuthController,
    StaffController,
    PasswordResetController,
    StaffInvitationController,
    StaffInvitationAcceptController,
  ],
  providers: [
    AuthService,
    StaffAdministrationService,
    PasswordResetService,
    StaffInvitationService,
    SerializeInterceptor,
    AccessPolicyCheck,
    { provide: APP_GUARD, useClass: AccessGuard },
  ],
  exports: [AuthService, SerializeInterceptor],
})
export class AuthModule {}
