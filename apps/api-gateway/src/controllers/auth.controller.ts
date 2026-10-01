import { Controller, Post, Body, Inject, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TAGS } from '../swagger/swagger-tags';
import { ClientProxy } from '@nestjs/microservices';
import { Throttle } from '@nestjs/throttler';
import { firstValueFrom } from 'rxjs';
import type { Request, Response } from 'express';
import {
  SERVICES,
  MESSAGE_PATTERNS,
  RegisterTenantDto,
  LoginDto,
  VerifyTwoFactorChallengeDto,
  RefreshTokenDto,
  LogoutDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  Public,
} from '@app/common';
import {
  clearRefreshCookie,
  readRefreshToken,
  setRefreshCookie,
  withoutRefreshToken,
} from '../auth/refresh-token-cookie';

@Controller('auth')
@Public()
export class ApiGatewayAuthController {
  constructor(
    @Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy,
  ) {}

  /**
   * Moves the refresh token out of the response body and into an httpOnly
   * cookie. A 2FA challenge carries no tokens, so it passes straight through.
   */
  private issueSession(res: Response, result: any) {
    if (!result?.refreshToken) return result;
    setRefreshCookie(res, result.refreshToken);
    return withoutRefreshToken(result);
  }

  @ApiTags(TAGS.ORG_AUTH)
  @Post('register-tenant')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Onboard organization via Auth Microservice' })
  registerTenant(@Body() dto: RegisterTenantDto) {
    return this.authClient.send(MESSAGE_PATTERNS.AUTH.REGISTER_TENANT, dto);
  }

  @ApiTags(TAGS.ORG_AUTH)
  @Post('login')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Authenticate user via Auth Microservice' })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.AUTH.LOGIN, {
        dto,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    );
    return this.issueSession(res, result);
  }

  @ApiTags(TAGS.ORG_AUTH)
  @Post('2fa/verify')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Verify 2FA Challenge OTP Code during Login' })
  async verifyTwoFactorLogin(
    @Body() dto: VerifyTwoFactorChallengeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.AUTH.VERIFY_2FA, {
        dto,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    );
    return this.issueSession(res, result);
  }

  /**
   * `AuthService.forgotPassword` / `resetPassword` were implemented and wired
   * to their message patterns, but no gateway route ever exposed them — so the
   * login page's "Forgot Password?" link pointed at a flow that existed
   * everywhere except the edge. Both are throttled: they take an email address
   * and send mail, which makes them an enumeration and spam vector otherwise.
   */
  @ApiTags(TAGS.ORG_AUTH)
  @Post('forgot-password')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Email a password-reset OTP' })
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authClient.send(MESSAGE_PATTERNS.AUTH.FORGOT_PASSWORD, dto);
  }

  @ApiTags(TAGS.ORG_AUTH)
  @Post('reset-password')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @ApiOperation({ summary: 'Set a new password using the emailed OTP' })
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authClient.send(MESSAGE_PATTERNS.AUTH.RESET_PASSWORD, dto);
  }

  @ApiTags(TAGS.ORG_AUTH)
  @Post('refresh')
  @ApiOperation({ summary: 'Exchange the refresh token cookie for a new access token' })
  async refreshToken(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = readRefreshToken(req, dto?.refreshToken);
    if (!refreshToken) {
      // Distinguishable from a rejected token only by message — both are 401,
      // so a caller can't probe for whether a session exists.
      throw new UnauthorizedException('No refresh token supplied. Please log in again.');
    }

    try {
      const result = await firstValueFrom(
        this.authClient.send(MESSAGE_PATTERNS.AUTH.REFRESH_TOKEN, {
          dto: { refreshToken },
          ipAddress: req.ip,
          userAgent: req.headers['user-agent'],
        }),
      );
      return this.issueSession(res, result);
    } catch (error) {
      // The session is gone or the token was replayed (which revokes it
      // server-side) — leaving the cookie in place would make every future
      // boot retry a credential that can never succeed again.
      clearRefreshCookie(res);
      throw error;
    }
  }

  @ApiTags(TAGS.ORG_AUTH)
  @Post('logout')
  @ApiOperation({ summary: 'Revoke the session tied to the refresh token cookie' })
  async logout(
    @Body() dto: LogoutDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = readRefreshToken(req, dto?.refreshToken);

    // Cleared before the call and regardless of its outcome: sign-out must
    // leave the browser without a credential even if revocation fails.
    clearRefreshCookie(res);

    return firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.AUTH.LOGOUT, {
        dto: { refreshToken },
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
      }),
    );
  }
}
