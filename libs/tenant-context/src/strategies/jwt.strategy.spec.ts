import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtStrategy } from './jwt.strategy';

/**
 * Regression cover for the token-type check.
 *
 * The audited bug was `if (payload.type && payload.type !== 'access')`, which
 * only rejected a token whose `type` was present and wrong — so any token
 * that simply omitted the claim authenticated. The 2FA challenge token was
 * exactly that shape, which meant presenting a half-authenticated challenge
 * token passed JwtAuthGuard. The first test below is the one that would have
 * caught it.
 */
describe('JwtStrategy', () => {
  const config = (secret?: string) =>
    ({ get: () => secret }) as unknown as ConfigService;

  const build = () => new JwtStrategy(config('test-secret'));

  describe('constructor', () => {
    it('refuses to construct without JWT_SECRET rather than using a fallback', () => {
      expect(() => new JwtStrategy(config(undefined))).toThrow(
        /JWT_SECRET is required and must not be empty/,
      );
    });

    it('constructs when a secret is configured', () => {
      expect(() => build()).not.toThrow();
    });
  });

  describe('validate', () => {
    const accessPayload = {
      sub: 'user-1',
      id: 'user-1',
      email: 'admin@example.com',
      tenantId: 'tenant-1',
      roles: ['admin'],
      type: 'access',
      sid: 'session-1',
    };

    it('accepts a token explicitly typed as access', async () => {
      const user = await build().validate(accessPayload);
      expect(user.id).toBe('user-1');
      expect(user.tenantId).toBe('tenant-1');
      expect(user.roles).toEqual(['admin']);
    });

    it('rejects a 2FA challenge token', async () => {
      await expect(
        build().validate({
          sub: 'admin-1',
          id: 'admin-1',
          email: 'admin@example.com',
          is2faPending: true,
          type: '2fa_challenge',
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a token that omits the type claim entirely', async () => {
      // The original 2FA challenge payload had no `type` at all. Even now that
      // challenge tokens are tagged, an untyped token must not authenticate —
      // otherwise the same class of bug returns the next time some other flow
      // mints a token without the claim.
      await expect(
        build().validate({
          sub: 'admin-1',
          id: 'admin-1',
          email: 'admin@example.com',
          is2faPending: true,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a refresh token presented as a bearer token', async () => {
      await expect(
        build().validate({ sub: 'user-1', sid: 'session-1', type: 'refresh' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a payload carrying no subject', async () => {
      await expect(build().validate({ type: 'access' })).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('does not infer superadmin from a challenge-shaped payload', async () => {
      // Defence in depth: even if a future change let an untyped token
      // through, it must not arrive carrying roles it was never granted.
      // This is what actually contained the audited bug in practice.
      const user = await build().validate({
        ...accessPayload,
        roles: [],
        role: undefined,
        isSuperAdmin: undefined,
      });
      expect(user.isSuperAdmin).toBe(false);
      expect(user.roles).toEqual([]);
    });

    it('derives roles from a singular role claim', async () => {
      const user = await build().validate({
        ...accessPayload,
        roles: undefined,
        role: 'organization_admin',
      });
      expect(user.roles).toEqual(['organization_admin']);
    });

    it('recognises superadmin from the roles array', async () => {
      const user = await build().validate({
        ...accessPayload,
        roles: ['superadmin'],
      });
      expect(user.isSuperAdmin).toBe(true);
    });

    it('passes permissions through, defaulting to an empty list', async () => {
      // PermissionsGuard reads `user.permissions`; the strategy never emitted
      // it, so every fine-grained check fell through to the admin bypass.
      const withPerms = await build().validate({
        ...accessPayload,
        permissions: ['recruitment.view'],
      });
      expect(withPerms.permissions).toEqual(['recruitment.view']);

      const withoutPerms = await build().validate(accessPayload);
      expect(withoutPerms.permissions).toEqual([]);
    });

    it('passes isFullAccess through when flag is set or wildcard permission is present', async () => {
      const explicitFull = await build().validate({
        ...accessPayload,
        isFullAccess: true,
      });
      expect(explicitFull.isFullAccess).toBe(true);

      const wildcardFull = await build().validate({
        ...accessPayload,
        permissions: ['*'],
      });
      expect(wildcardFull.isFullAccess).toBe(true);

      const regular = await build().validate({
        ...accessPayload,
        permissions: ['employee.view'],
      });
      expect(regular.isFullAccess).toBe(false);
    });

    it('passes tenantUserId through', async () => {
      const user = await build().validate({
        ...accessPayload,
        tenantUserId: 'tenant-user-uuid',
      });
      expect(user.tenantUserId).toBe('tenant-user-uuid');
    });
  });
});
