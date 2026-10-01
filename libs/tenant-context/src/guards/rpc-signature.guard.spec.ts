import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { RpcException } from '@nestjs/microservices';
import {
  MicroserviceAuthContext,
  attachRpcSignature,
  signMicroservicePayload,
} from '@app/common';
import { RpcSignatureGuard } from './rpc-signature.guard';

const SECRET = 'test-signing-secret';

const CONTEXT: MicroserviceAuthContext = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  roles: ['admin'],
  isSuperAdmin: false,
};

function makeContext(data: unknown, type = 'rpc'): ExecutionContext {
  return {
    getType: () => type,
    getClass: () => ({ name: 'TestController' }),
    getHandler: () => ({ name: 'testHandler' }),
    switchToRpc: () => ({ getData: () => data }),
  } as unknown as ExecutionContext;
}

function makeGuard(
  env: Record<string, string | undefined>,
  allowUnsigned = false,
): RpcSignatureGuard {
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  const reflector = {
    getAllAndOverride: () => allowUnsigned,
  } as unknown as Reflector;
  return new RpcSignatureGuard(config, reflector);
}

describe('RpcSignatureGuard', () => {
  describe('when enforcement is on', () => {
    const env = {
      MICROSERVICE_SIGNING_SECRET: SECRET,
      MICROSERVICE_SIGNING_ENFORCED: 'true',
    };

    it('accepts an in-place signed payload and strips the signature', () => {
      const guard = makeGuard(env);
      const payload = attachRpcSignature({ id: 'abc' }, CONTEXT, SECRET);

      expect(guard.canActivate(makeContext(payload))).toBe(true);
      expect(payload).toEqual({ id: 'abc' });
    });

    it('accepts the nested envelope form and leaves it intact', () => {
      const guard = makeGuard(env);
      const envelope = signMicroservicePayload({ id: 'abc' }, CONTEXT, SECRET);

      expect(guard.canActivate(makeContext(envelope))).toBe(true);
      expect(envelope.data).toEqual({ id: 'abc' });
      expect(envelope.signature).toBeDefined();
    });

    it('rejects an unsigned payload', () => {
      const guard = makeGuard(env);
      expect(() => guard.canActivate(makeContext({ id: 'abc' }))).toThrow(
        RpcException,
      );
    });

    it('rejects a payload signed with the wrong secret', () => {
      const guard = makeGuard(env);
      const payload = attachRpcSignature(
        { id: 'abc' },
        CONTEXT,
        'wrong-secret',
      );

      expect(() => guard.canActivate(makeContext(payload))).toThrow(
        RpcException,
      );
    });

    it('rejects a tampered envelope', () => {
      const guard = makeGuard(env);
      const envelope: any = signMicroservicePayload(
        { id: 'abc' },
        CONTEXT,
        SECRET,
      );
      envelope.data.id = 'tampered';

      expect(() => guard.canActivate(makeContext(envelope))).toThrow(
        RpcException,
      );
    });

    it('allows a handler explicitly marked as unsigned-safe', () => {
      const guard = makeGuard(env, true);
      expect(guard.canActivate(makeContext({ id: 'abc' }))).toBe(true);
    });

    it('ignores non-rpc contexts', () => {
      const guard = makeGuard(env);
      expect(guard.canActivate(makeContext({ id: 'abc' }, 'http'))).toBe(true);
    });
  });

  describe('when enforcement is off', () => {
    const env = {
      MICROSERVICE_SIGNING_SECRET: SECRET,
      MICROSERVICE_SIGNING_ENFORCED: 'false',
    };

    it('lets an unsigned payload through so a partial deploy keeps working', () => {
      const guard = makeGuard(env);
      expect(guard.canActivate(makeContext({ id: 'abc' }))).toBe(true);
    });

    it('still strips the signature from a validly signed payload', () => {
      const guard = makeGuard(env);
      const payload = attachRpcSignature({ id: 'abc' }, CONTEXT, SECRET);

      expect(guard.canActivate(makeContext(payload))).toBe(true);
      expect(payload).toEqual({ id: 'abc' });
    });
  });

  describe('enforcement default', () => {
    it('is on in production', () => {
      const guard = makeGuard({
        MICROSERVICE_SIGNING_SECRET: SECRET,
        NODE_ENV: 'production',
      });
      expect(() => guard.canActivate(makeContext({ id: 'abc' }))).toThrow(
        RpcException,
      );
    });

    it('is off outside production', () => {
      const guard = makeGuard({
        MICROSERVICE_SIGNING_SECRET: SECRET,
        NODE_ENV: 'development',
      });
      expect(guard.canActivate(makeContext({ id: 'abc' }))).toBe(true);
    });
  });

  it('refuses to run at all without a signing secret', () => {
    const guard = makeGuard({ MICROSERVICE_SIGNING_ENFORCED: 'true' });
    expect(() => guard.canActivate(makeContext({ id: 'abc' }))).toThrow(
      /MICROSERVICE_SIGNING_SECRET/,
    );
  });
});
