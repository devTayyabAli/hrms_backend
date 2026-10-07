import { Injectable, ExecutionContext, UnauthorizedException, Optional, Inject, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, isObservable } from 'rxjs';
import { IS_PUBLIC_KEY, MESSAGE_PATTERNS, SERVICES } from '@app/common';
import { AccessStateCache } from './access-state.cache';

/** Whether a session is still usable, as auth-service reports it. */
export interface SessionState {
  active: boolean;
  reason?: string;
}

/**
 * Shared by every guard instance in the process, so a logout handled by one
 * controller is seen by all of them. A revocation done elsewhere (another
 * gateway instance, refresh-token reuse detection) takes up to the TTL.
 */
const sessionStates = new AccessStateCache<SessionState>(
  parseInt(process.env.SESSION_STATE_TTL_MS || '60000', 10),
);

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private reflector: Reflector,
    @Optional() @Inject(SERVICES.AUTH_SERVICE) private readonly authClient?: ClientProxy,
  ) {
    super();
  }

  /** Forget one session's cached state — call after logging it out or revoking it. */
  static forgetSession(sessionId: string): void {
    sessionStates.delete(sessionId);
  }

  /** Forget every cached session state — after "sign out everywhere else". */
  static forgetAllSessions(): void {
    sessionStates.clear();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if ((context.getType() as string) === 'rpc') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const verdict = super.canActivate(context);
    const valid = isObservable(verdict) ? await firstValueFrom(verdict) : await verdict;
    if (!valid) return false;

    await this.assertSessionActive(context.switchToHttp().getRequest().user?.sid);
    return true;
  }

  /**
   * A signed, unexpired access token isn't enough on its own: the session it
   * belongs to may have been logged out or revoked since it was issued, and
   * the token would otherwise keep working until it expired.
   *
   * Tokens without a session id (issued before sessions were recorded) and
   * processes with no auth-service client are let through as before. If
   * auth-service can't be reached the request is allowed and the miss isn't
   * cached — an auth-service outage shouldn't sign every user out.
   */
  private async assertSessionActive(sessionId: string | undefined): Promise<void> {
    if (!sessionId || !this.authClient) return;

    let state: SessionState;
    try {
      state = await sessionStates.get(sessionId, () =>
        firstValueFrom(this.authClient!.send<SessionState>(MESSAGE_PATTERNS.AUTH.GET_SESSION_STATE, { sessionId })),
      );
    } catch (error: any) {
      this.logger.warn(`Session check skipped (auth-service unavailable): ${error?.message ?? error}`);
      return;
    }

    if (!state.active) {
      throw new UnauthorizedException(state.reason || 'Your session has ended. Please sign in again.');
    }
  }

  handleRequest(err: any, user: any, info: any) {
    if (err || !user) {
      throw (
        err ||
        new UnauthorizedException(
          info?.message || 'Unauthorized access: Valid JWT Bearer token is required.',
        )
      );
    }
    return user;
  }
}
