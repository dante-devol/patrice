import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PasswordService } from './password';
import { SessionService } from './session.service';
import { SessionGuard } from './session.guard';
import { VerificationService } from './verification.service';
import { DiscordOAuthService } from './discord-oauth.service';
import { OAuthFlowService } from './oauth-flow.service';
import { AuthMailService } from './auth-mail.service';
import { AccountService } from './account.service';
import { AccountController } from './account.controller';

@Module({
  controllers: [AuthController, AccountController],
  providers: [
    AuthService,
    PasswordService,
    SessionService,
    SessionGuard,
    VerificationService,
    DiscordOAuthService,
    OAuthFlowService,
    AuthMailService,
    AccountService,
  ],
  exports: [
    AuthService,
    PasswordService,
    SessionService,
    SessionGuard,
    VerificationService,
    DiscordOAuthService,
    OAuthFlowService,
    AuthMailService,
    AccountService,
  ],
})
export class AuthModule {}
