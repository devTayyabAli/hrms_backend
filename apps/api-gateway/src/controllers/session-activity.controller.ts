import { Controller, HttpCode, Inject, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { MESSAGE_PATTERNS, SERVICES } from '@app/common';
import { CurrentUser, JwtAuthGuard } from '@app/tenant-context';
import { TAGS } from '../swagger/swagger-tags';

/**
 * The browser reports that its user is active, for the Security tab's session
 * idle timeout. Any signed-in user — Super Admin or tenant — calls it, at most
 * about once a minute while they are clicking or typing; the app's own
 * background polling never does, so it can't keep an idle session alive.
 */
@Controller('auth/session')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
@ApiTags(TAGS.ORG_AUTH)
export class SessionActivityController {
  constructor(@Inject(SERVICES.AUTH_SERVICE) private readonly authClient: ClientProxy) {}

  @Post('activity')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark this session active now; returns the idle timeout in minutes (0 = none)' })
  async activity(@CurrentUser('sid') sessionId?: string) {
    if (!sessionId) throw new UnauthorizedException('No session on this token.');
    const result: { active: boolean; idleTimeoutMinutes: number; passwordExpired?: boolean } = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.AUTH.TOUCH_SESSION, { sessionId }),
    );
    if (!result.active) {
      JwtAuthGuard.forgetSession(sessionId);
      throw new UnauthorizedException('This session has ended. Please sign in again.');
    }
    return { idleTimeoutMinutes: result.idleTimeoutMinutes, passwordExpired: Boolean(result.passwordExpired) };
  }

  /**
   * Sent about once a minute by every open, signed-in tab — touched or not —
   * so the Sessions list can show which devices are online right now. It
   * doesn't count as activity: an untouched tab still times out.
   */
  @Post('heartbeat')
  @HttpCode(204)
  @ApiOperation({ summary: 'Mark this device as present (online) without counting as activity' })
  async heartbeat(@CurrentUser('sid') sessionId?: string) {
    if (!sessionId) throw new UnauthorizedException('No session on this token.');
    const result: { active: boolean } = await firstValueFrom(
      this.authClient.send(MESSAGE_PATTERNS.AUTH.TOUCH_SESSION, { sessionId, presenceOnly: true }),
    );
    if (!result.active) {
      JwtAuthGuard.forgetSession(sessionId);
      throw new UnauthorizedException('This session has ended. Please sign in again.');
    }
  }
}
