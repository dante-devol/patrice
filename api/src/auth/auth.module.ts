import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password';
import { SessionService } from './session.service';
import { SessionGuard } from './session.guard';
import { VerificationService } from './verification.service';

@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    SessionGuard,
    VerificationService,
  ],
  exports: [
    AuthService,
    PasswordService,
    SessionService,
    SessionGuard,
    VerificationService,
  ],
})
export class AuthModule {}
