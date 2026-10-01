import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { CurrentUserPayload } from '@app/common';
import { requireJwtSecret } from '../config/require-jwt-secret';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // No fallback: a missing secret must stop the process, not silently
      // swap in a key that is published in this repository. Shared with the
      // JwtModule registration and auth-service so all three enforce it
      // identically — the gateway used to boot happily while auth-service
      // refused, which is how the fallback survived unnoticed.
      secretOrKey: requireJwtSecret(configService),
    });
  }

  async validate(payload: any): Promise<CurrentUserPayload> {
    if (!payload || (!payload.sub && !payload.id)) {
      throw new UnauthorizedException('Invalid JWT token payload');
    }

    // Require the claim rather than only rejecting a wrong one. The previous
    // `payload.type && payload.type !== 'access'` let any token that simply
    // omitted `type` through — which is exactly what the 2FA challenge token
    // did, so presenting a half-authenticated challenge token passed this
    // guard. Every real access token is minted by issueTokenPair() with
    // `type: 'access'`, so demanding it costs nothing and closes the class of
    // bug rather than the one instance.
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Token is not a valid access token');
    }

    const userId = payload.id || payload.sub;
    const roles = Array.isArray(payload.roles)
      ? payload.roles
      : payload.role
        ? [payload.role]
        : [];

    return {
      id: userId,
      email: payload.email,
      tenantId: payload.tenantId,
      role: payload.role || (roles.length > 0 ? roles[0] : undefined),
      roles,
      // Carried through so PermissionsGuard can read it. Nothing mints this
      // claim yet: the only login path is auth-service's AuthCredential,
      // whose holders are all admin-tier roles that the guard short-circuits
      // anyway. Passing it through means the guard is wired end to end, so
      // whichever path first issues fine-grained permissions works without a
      // second change here.
      permissions: Array.isArray(payload.permissions)
        ? payload.permissions
        : [],
      isFullAccess: !!payload.isFullAccess || payload.permissions?.includes('*'),
      // Whose records the permissions reach (ORGANIZATION / DEPARTMENT / TEAM /
      // SELF). Absent on older tokens — read as organization-wide.
      dataScope: typeof payload.dataScope === 'string' ? payload.dataScope : undefined,
      isSuperAdmin: !!payload.isSuperAdmin || roles.includes('superadmin'),
      tenantUserId: payload.tenantUserId,
      // Session id the token was issued for — lets the Sessions screen mark
      // the caller's own row as "Current".
      sid: payload.sid,
    };
  }
}
