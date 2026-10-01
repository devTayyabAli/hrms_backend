import {
  RPC_SIGNATURE_KEY,
  SIGNATURE_MAX_AGE_MS,
  attachRpcSignature,
  isSignedEnvelope,
  signMicroservicePayload,
  verifyAndStripRpcSignature,
  verifyMicroservicePayload,
} from './request-signing.util';
import { MicroserviceAuthContext } from '../interfaces/microservice-auth.interface';

const SECRET = 'test-signing-secret';
const OTHER_SECRET = 'a-different-signing-secret';

const CONTEXT: MicroserviceAuthContext = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  roles: ['admin'],
  isSuperAdmin: false,
  correlationId: 'corr-1',
};

describe('attachRpcSignature / verifyAndStripRpcSignature', () => {
  it('round-trips a payload and strips the signature property', () => {
    const signed = attachRpcSignature({ id: 'abc', count: 2 }, CONTEXT, SECRET);

    expect(signed).toHaveProperty(RPC_SIGNATURE_KEY);

    const result = verifyAndStripRpcSignature(signed, SECRET);

    expect(result.valid).toBe(true);
    expect(result.context).toEqual(CONTEXT);
    // Stripping is what lets the ValidationPipe's forbidNonWhitelisted run
    // against the handler's DTO without rejecting the signature field.
    expect(signed).not.toHaveProperty(RPC_SIGNATURE_KEY);
    expect(signed).toEqual({ id: 'abc', count: 2 });
  });

  it('does not mutate the caller-supplied payload', () => {
    const original = { id: 'abc' };
    attachRpcSignature(original, CONTEXT, SECRET);
    expect(original).toEqual({ id: 'abc' });
  });

  it('rejects a payload whose body was altered after signing', () => {
    const signed: any = attachRpcSignature({ amount: 10 }, CONTEXT, SECRET);
    signed.amount = 1_000_000;

    expect(verifyAndStripRpcSignature(signed, SECRET).valid).toBe(false);
  });

  it('rejects a payload signed with a different secret', () => {
    const signed = attachRpcSignature({ id: 'abc' }, CONTEXT, OTHER_SECRET);
    expect(verifyAndStripRpcSignature(signed, SECRET).valid).toBe(false);
  });

  it('rejects an escalated context, since the context is covered by the HMAC', () => {
    const signed: any = attachRpcSignature({ id: 'abc' }, CONTEXT, SECRET);
    signed[RPC_SIGNATURE_KEY].context.isSuperAdmin = true;
    signed[RPC_SIGNATURE_KEY].context.roles = ['superadmin'];

    expect(verifyAndStripRpcSignature(signed, SECRET).valid).toBe(false);
  });

  it('rejects an unsigned payload', () => {
    const result = verifyAndStripRpcSignature({ id: 'abc' }, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/no signature/i);
  });

  it('rejects a replayed message once the signature has aged out', () => {
    const signed: any = attachRpcSignature({ id: 'abc' }, CONTEXT, SECRET);
    signed[RPC_SIGNATURE_KEY].timestamp = Date.now() - SIGNATURE_MAX_AGE_MS - 1;

    const result = verifyAndStripRpcSignature(signed, SECRET);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/expired/i);
  });

  it('rejects non-object payloads rather than letting them through unsigned', () => {
    expect(verifyAndStripRpcSignature('a-string', SECRET).valid).toBe(false);
    expect(verifyAndStripRpcSignature(null, SECRET).valid).toBe(false);
    expect(verifyAndStripRpcSignature([1, 2], SECRET).valid).toBe(false);
  });

  it('leaves a non-signable payload untouched when signing', () => {
    expect(attachRpcSignature('plain', CONTEXT, SECRET)).toBe('plain');
  });
});

describe('isSignedEnvelope', () => {
  it('recognizes the nested envelope form', () => {
    const envelope = signMicroservicePayload({ id: 'abc' }, CONTEXT, SECRET);
    expect(isSignedEnvelope(envelope)).toBe(true);
    expect(verifyMicroservicePayload(envelope, SECRET)).toBe(true);
  });

  it('does not mistake an in-place signed payload for the envelope form', () => {
    const signed = attachRpcSignature({ id: 'abc' }, CONTEXT, SECRET);
    expect(isSignedEnvelope(signed)).toBe(false);
  });

  it('does not mistake an ordinary payload for the envelope form', () => {
    expect(isSignedEnvelope({ id: 'abc' })).toBe(false);
  });
});
