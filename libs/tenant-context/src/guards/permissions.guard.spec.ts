import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';

function makeContext(user: unknown, type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    getClass: () => class {},
    getHandler: () => () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function makeGuard(
  requiredPermissions: string[] | undefined,
  isPublic = false,
): PermissionsGuard {
  const reflector = {
    getAllAndOverride: (key: string) =>
      key === 'isPublic' ? isPublic : requiredPermissions,
  } as unknown as Reflector;
  return new PermissionsGuard(reflector);
}

describe('PermissionsGuard', () => {
  it('allows a route that declares no permissions', () => {
    expect(makeGuard(undefined).canActivate(makeContext({ roles: [] }))).toBe(
      true,
    );
  });

  it('allows a public route', () => {
    expect(
      makeGuard(['employee.view'], true).canActivate(makeContext(undefined)),
    ).toBe(true);
  });

  it('skips rpc contexts', () => {
    expect(
      makeGuard(['employee.view']).canActivate(makeContext(undefined, 'rpc')),
    ).toBe(true);
  });

  it('rejects a request with no user context', () => {
    expect(() =>
      makeGuard(['employee.view']).canActivate(makeContext(undefined)),
    ).toThrow(ForbiddenException);
  });

  it('always lets a superadmin through', () => {
    expect(
      makeGuard(['employee.view']).canActivate(
        makeContext({ roles: ['superadmin'], permissions: [] }),
      ),
    ).toBe(true);
  });

  it('lets a superadmin through even when their claims omit the permission', () => {
    expect(
      makeGuard(['employee.view']).canActivate(
        makeContext({ roles: ['superadmin'], permissions: ['something.else'] }),
      ),
    ).toBe(true);
  });

  it('grants a permission the user actually holds', () => {
    expect(
      makeGuard(['employee.view']).canActivate(
        makeContext({ roles: ['viewer'], permissions: ['employee.view'] }),
      ),
    ).toBe(true);
  });

  it('denies a user whose permissions do not cover the route', () => {
    expect(() =>
      makeGuard(['employee.manage']).canActivate(
        makeContext({ roles: ['viewer'], permissions: ['employee.view'] }),
      ),
    ).toThrow(ForbiddenException);
  });

  describe('full access and empty permissions semantics', () => {
    it('allows user with explicit isFullAccess', () => {
      expect(
        makeGuard(['employee.manage']).canActivate(
          makeContext({ roles: ['organization_admin'], permissions: [], isFullAccess: true }),
        ),
      ).toBe(true);
    });

    it('allows user with wildcard permission *', () => {
      expect(
        makeGuard(['employee.manage']).canActivate(
          makeContext({ roles: ['organization_admin'], permissions: ['*'] }),
        ),
      ).toBe(true);
    });

    it('denies user with empty permissions when not full access', () => {
      expect(() =>
        makeGuard(['employee.manage']).canActivate(
          makeContext({
            roles: ['organization_admin'],
            permissions: [],
            isFullAccess: false,
          }),
        ),
      ).toThrow(ForbiddenException);
    });

    it('denies regular user with empty permissions', () => {
      expect(() =>
        makeGuard(['employee.view']).canActivate(
          makeContext({
            roles: ['Employee'],
            permissions: [],
          }),
        ),
      ).toThrow(ForbiddenException);
    });

    it('honours a claim an admin does hold', () => {
      expect(
        makeGuard(['employee.manage']).canActivate(
          makeContext({
            roles: ['admin'],
            permissions: ['employee.manage'],
          }),
        ),
      ).toBe(true);
    });

    it('allows resource.manage to satisfy any action on that resource', () => {
      expect(
        makeGuard(['employee.view']).canActivate(
          makeContext({
            roles: ['hr'],
            permissions: ['employee.manage'],
          }),
        ),
      ).toBe(true);
    });
  });

  describe('permission aliases', () => {
    it('accepts user_management.manage for users:read', () => {
      expect(
        makeGuard(['users:read']).canActivate(
          makeContext({
            roles: ['viewer'],
            permissions: ['user_management.manage'],
          }),
        ),
      ).toBe(true);
    });

    it('accepts user_management.create for users:write', () => {
      expect(
        makeGuard(['users:write']).canActivate(
          makeContext({
            roles: ['viewer'],
            permissions: ['user_management.create'],
          }),
        ),
      ).toBe(true);
    });
  });
});
