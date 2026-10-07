import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { of, throwError } from 'rxjs';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * A valid token isn't enough: its session must still be live. These pin the
 * session check layered on top of passport's signature verification.
 */
describe('JwtAuthGuard session check', () => {
  // Stand-in for passport: the token verified and `user` was attached.
  const passport = jest.spyOn(AuthGuard('jwt').prototype, 'canActivate').mockResolvedValue(true as never);

  afterAll(() => passport.mockRestore());

  let n = 0;
  const freshSid = () => `44444444-4444-4444-8444-${String(++n).padStart(12, '0')}`;

  const contextFor = (user: any) =>
    ({
      getType: () => 'http',
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as any;

  const guardWith = (send: jest.Mock) => {
    const reflector = new Reflector();
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    return new JwtAuthGuard(reflector, { send } as any);
  };

  it('allows a live session', async () => {
    const guard = guardWith(jest.fn(() => of({ active: true })));
    await expect(guard.canActivate(contextFor({ id: 'u1', sid: freshSid() }))).resolves.toBe(true);
  });

  it('refuses a logged-out session even though its token is still valid', async () => {
    const guard = guardWith(jest.fn(() => of({ active: false, reason: 'You have been signed out.' })));
    await expect(guard.canActivate(contextFor({ id: 'u1', sid: freshSid() }))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('checks a session once and serves repeat requests from cache', async () => {
    const send = jest.fn(() => of({ active: true }));
    const guard = guardWith(send);
    const user = { id: 'u1', sid: freshSid() };
    await guard.canActivate(contextFor(user));
    await guard.canActivate(contextFor(user));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sees a logout at once after forgetSession', async () => {
    const user = { id: 'u1', sid: freshSid() };
    await guardWith(jest.fn(() => of({ active: true }))).canActivate(contextFor(user));
    JwtAuthGuard.forgetSession(user.sid);
    const guard = guardWith(jest.fn(() => of({ active: false })));
    await expect(guard.canActivate(contextFor(user))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('skips the check for a token with no session id', async () => {
    const send = jest.fn();
    await expect(guardWith(send).canActivate(contextFor({ id: 'u1' }))).resolves.toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('lets the request through when auth-service cannot be reached', async () => {
    const guard = guardWith(jest.fn(() => throwError(() => new Error('ECONNREFUSED'))));
    await expect(guard.canActivate(contextFor({ id: 'u1', sid: freshSid() }))).resolves.toBe(true);
  });
});
